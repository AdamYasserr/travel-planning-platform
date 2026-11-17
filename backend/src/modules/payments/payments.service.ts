import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import Stripe from 'stripe';

import { StripeService } from '../../integrations/stripe/stripe.service';
import { assertBookingTransition } from '../../common/booking/booking-status';
import {
  FlightBooking,
} from '../flight-bookings/schemas/flight-booking.schema';
import { FlightBookingStatus } from '../flight-bookings/enums/flight-booking-status.enum';
import { CabinInventory } from '../flights/schemas/cabin-inventory.schema';
import {
  HotelBooking,
  HotelBookingStatus,
} from '../hotel-bookings/schemas/hotel-booking.schema';
import {
  Payment,
  StripeWebhookEvent,
  StripeWebhookEventStatus,
} from './schemas/payment.schema';
import {
  PaymentBookingType,
  PaymentStatus,
} from './enums/payment-status.enum';
import { RefundStatus } from './enums/refund-status.enum';
import { CreateCheckoutSessionDto } from './dto/payments.dto';

const EXPIRATION_BATCH_SIZE = 100;
const DAY_MS = 86_400_000;

type CheckoutBooking = (HotelBooking | FlightBooking) & {
  _id: Types.ObjectId;
};

type CancellationResult = {
  booking: HotelBooking | FlightBooking;
  payment?: Payment | null;
  refundPercentage: number;
  expireSessionId?: string;
  cancelPaymentIntentId?: string;
  retryRefund?: boolean;
  conflict?: string;
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(Payment.name)
    private readonly paymentModel: Model<Payment>,
    @InjectModel(StripeWebhookEvent.name)
    private readonly webhookEventModel: Model<StripeWebhookEvent>,
    @InjectModel(HotelBooking.name)
    private readonly hotelBookingModel: Model<HotelBooking>,
    @InjectModel(FlightBooking.name)
    private readonly flightBookingModel: Model<FlightBooking>,
    @InjectModel(CabinInventory.name)
    private readonly inventoryModel: Model<CabinInventory>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly stripeService: StripeService,
  ) {}

  async createCheckoutSession(
    userId: string,
    dto: CreateCheckoutSessionDto,
  ) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(dto.bookingId)) {
      throw new BadRequestException('Invalid user or booking ID');
    }

    const booking = await this.findOwnedBooking(
      userId,
      dto.bookingType,
      dto.bookingId,
    );
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.status !== this.pendingStatus(dto.bookingType)) {
      throw new ConflictException('Only pending bookings can be paid');
    }
    const now = new Date();
    if (!booking.holdExpiresAt || booking.holdExpiresAt <= now) {
      await this.expireBooking(dto.bookingType, booking._id.toString(), now);
      throw new ConflictException('The booking hold has expired');
    }

    const currency = booking.currency?.trim().toUpperCase();
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new ConflictException('The booking has no valid payment currency');
    }
    const amountMinor = this.toMinorUnits(booking.totalPrice, currency);
    const bookingType = dto.bookingType;
    const bookingId = new Types.ObjectId(dto.bookingId);
    let payment: Payment | null;
    try {
      payment = await this.paymentModel
        .findOneAndUpdate(
          { bookingType, bookingId },
          {
            $setOnInsert: {
              userId: new Types.ObjectId(userId),
              bookingType,
              bookingId,
              amountMinor,
              currency: currency.toLowerCase(),
              status: PaymentStatus.PENDING,
              holdExpiresAt: booking.holdExpiresAt,
              refundAmountMinor: 0,
              refundPercentage: 0,
              refundStatus: RefundStatus.NOT_REQUIRED,
            },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        )
        .exec();
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      payment = await this.paymentModel.findOne({ bookingType, bookingId }).exec();
    }
    if (!payment || payment.userId.toString() !== userId) {
      throw new ConflictException('A payment could not be created for this booking');
    }
    if (
      payment.amountMinor !== amountMinor ||
      payment.currency !== currency.toLowerCase()
    ) {
      throw new ConflictException('The saved payment amount does not match the booking');
    }
    if (
      payment.status === PaymentStatus.SUCCEEDED ||
      payment.status === PaymentStatus.EXPIRED ||
      payment.status === PaymentStatus.REFUND_PENDING ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new ConflictException('This booking already has a completed payment');
    }
    if (payment.stripeCheckoutUrl && payment.stripeCheckoutSessionId) {
      return this.checkoutResponse(payment);
    }

    const session = await this.stripeService.createCheckoutSession({
      paymentId: payment._id.toString(),
      bookingType,
      bookingId: booking._id.toString(),
      userId,
      productName: this.productName(bookingType, booking.reference),
      amountMinor,
      currency: currency.toLowerCase(),
    });
    const updated = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id },
        {
          $set: {
            stripeCheckoutSessionId: session.id,
            stripeCheckoutUrl: session.url,
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new ServiceUnavailableException(
        'The Checkout Session was created but could not be recorded',
      );
    }
    return this.checkoutResponse(updated);
  }

  async getForUser(userId: string, paymentId: string) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(paymentId)) {
      throw new BadRequestException('Invalid user or payment ID');
    }
    const payment = await this.paymentModel
      .findOne({ _id: paymentId, userId })
      .select({
        userId: 0,
        stripeCheckoutSessionId: 0,
        stripePaymentIntentId: 0,
        stripeRefundId: 0,
      })
      .lean()
      .exec();
    if (!payment) throw new NotFoundException('Payment not found');
    return { ...payment, refundId: this.refundIdFor(payment) };
  }

  /**
   * GET /refunds/:id. A refund is not a separate record yet: its id is the payment id
   * (`refundId` on the payment and on the cancellation response).
   */
  async getRefundForUser(userId: string, refundId: string) {
    const payment = await this.getForUser(userId, refundId);
    if (!payment.refundId) {
      throw new NotFoundException('No refund exists for this payment');
    }
    return {
      refundId: payment.refundId,
      paymentId: String(payment._id),
      bookingType: payment.bookingType,
      bookingId: payment.bookingId,
      status: payment.refundStatus,
      percentage: payment.refundPercentage,
      amountMinor: payment.refundAmountMinor,
      currency: payment.currency,
      requestedAt: payment.refundRequestedAt ?? null,
      refundedAt: payment.refundedAt ?? null,
    };
  }

  private refundIdFor(payment: { _id: unknown; refundStatus?: RefundStatus; refundAmountMinor?: number }): string | null {
    const hasRefund =
      (payment.refundStatus ?? RefundStatus.NOT_REQUIRED) !== RefundStatus.NOT_REQUIRED ||
      (payment.refundAmountMinor ?? 0) > 0;
    return hasRefund ? String(payment._id) : null;
  }

  async handleStripeWebhook(payload: Buffer, signature: string) {
    let event: Stripe.Event;
    try {
      event = this.stripeService.constructWebhookEvent(payload, signature);
    } catch {
      throw new BadRequestException('Invalid Stripe webhook signature');
    }

    let paymentId: Types.ObjectId | null = null;
    try {
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          const existingEvent = await this.webhookEventModel
            .findOne({ stripeEventId: event.id })
            .session(session)
            .exec();
          if (existingEvent) {
            paymentId = existingEvent.paymentId ?? null;
            return;
          }

          const [eventRecord] = await this.webhookEventModel.create(
            [
              {
                stripeEventId: event.id,
                eventType: event.type,
                status: StripeWebhookEventStatus.PROCESSING,
              },
            ],
            { session },
          );

          const payment = await this.findPaymentForEvent(event, session);
          if (payment) {
            paymentId = payment._id;
            await this.applyEvent(event, payment, session);
            eventRecord.paymentId = payment._id;
          }
          eventRecord.status = StripeWebhookEventStatus.PROCESSED;
          eventRecord.processedAt = new Date();
          await eventRecord.save({ session });
        });
      } finally {
        await session.endSession();
      }
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
    }

    if (paymentId) {
      const payment = await this.paymentModel.findById(paymentId).exec();
      if (payment?.refundStatus === RefundStatus.PENDING) {
        await this.processRefund(payment);
      }
    }
  }

  async cancelBooking(
    userId: string,
    bookingType: PaymentBookingType,
    bookingId: string,
  ) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException('Invalid user or booking ID');
    }

    let result: CancellationResult | undefined;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const booking = await this.findOwnedBooking(
          userId,
          bookingType,
          bookingId,
          session,
        );
        if (!booking) {
          throw new NotFoundException('Booking not found');
        }
        const payment = await this.paymentModel
          .findOne({ bookingType, bookingId: booking._id })
          .session(session)
          .exec();
        const pendingStatus = this.pendingStatus(bookingType);
        const confirmedStatus = this.confirmedStatus(bookingType);
        const cancelledStatus = this.cancelledStatus(bookingType);

        // A second cancel is rejected and never starts another refund. A refund that is still
        // Pending is retried by the retryPendingRefunds job, not by repeating the cancel.
        if (booking.status === cancelledStatus) {
          result = {
            booking,
            payment,
            refundPercentage: payment?.refundPercentage ?? 0,
            conflict: 'This booking is already cancelled',
          };
          return;
        }
        if (booking.status !== pendingStatus && booking.status !== confirmedStatus) {
          result = {
            booking,
            payment,
            refundPercentage: 0,
            conflict: 'This booking cannot be cancelled',
          };
          return;
        }

        const now = new Date();
        if (booking.status === pendingStatus) {
          if (booking.holdExpiresAt && booking.holdExpiresAt <= now) {
            await this.expireBookingInTransaction(
              bookingType,
              booking._id,
              now,
              session,
            );
            result = {
              booking,
              payment,
              refundPercentage: 0,
              conflict: 'The booking hold has expired',
            };
            return;
          }
          // GEN-11: only Confirmed -> Cancelled is allowed, so a user abandoning an unpaid
          // hold releases it as Expired (rooms/seats are freed, Stripe session/intent cancelled).
          const cancelled = await this.updateBookingStatus(
            bookingType,
            booking._id,
            userId,
            pendingStatus,
            this.expiredStatus(bookingType),
            now,
            session,
          );
          if (!cancelled) {
            throw new ConflictException('The booking changed while being cancelled');
          }
          if (bookingType === PaymentBookingType.FLIGHT) {
            await this.releaseFlightSeats(booking as FlightBooking, session);
          }
          if (payment && payment.status !== PaymentStatus.SUCCEEDED) {
            payment.status = PaymentStatus.EXPIRED;
            await this.persistPayment(payment, session);
          }
          result = {
            booking: cancelled,
            payment,
            refundPercentage: 0,
            expireSessionId: payment?.stripeCheckoutSessionId,
            cancelPaymentIntentId:
              payment && payment.status !== PaymentStatus.SUCCEEDED
                ? payment.stripePaymentIntentId
                : undefined,
          };
          return;
        }

        if (!payment || payment.status !== PaymentStatus.SUCCEEDED) {
          result = {
            booking,
            payment,
            refundPercentage: 0,
            conflict: 'A confirmed booking has no successful payment record',
          };
          return;
        }
        if (this.isFinished(bookingType, booking, now)) {
          result = {
            booking,
            payment,
            refundPercentage: 0,
            conflict:
              bookingType === PaymentBookingType.FLIGHT
                ? 'A flight booking cannot be cancelled after departure'
                : 'A hotel booking cannot be cancelled after check-out',
          };
          return;
        }
        const refundPercentage = this.getCancellationRefundPercentage(
          bookingType,
          booking as HotelBooking | FlightBooking,
          now,
        );
        if (
          bookingType === PaymentBookingType.FLIGHT &&
          !(booking as FlightBooking).cancellationTiers?.length
        ) {
          result = {
            booking,
            payment,
            refundPercentage: 0,
            conflict: 'The airline cancellation policy is not configured for this booking',
          };
          return;
        }

        const cancelled = await this.updateBookingStatus(
          bookingType,
          booking._id,
          userId,
          confirmedStatus,
          cancelledStatus,
          now,
          session,
        );
        if (!cancelled) {
          throw new ConflictException('The booking changed while being cancelled');
        }
        if (bookingType === PaymentBookingType.FLIGHT) {
          await this.releaseFlightSeats(booking as FlightBooking, session);
        }
        const refundAmountMinor = Math.round(
          (payment.amountMinor * refundPercentage) / 100,
        );
        payment.refundPercentage = refundPercentage;
        payment.refundAmountMinor = refundAmountMinor;
        if (refundAmountMinor > 0) {
          payment.refundStatus = RefundStatus.PENDING;
          payment.status = PaymentStatus.REFUND_PENDING;
          payment.refundRequestedAt = now;
        }
        await this.persistPayment(payment, session);
        result = {
          booking: cancelled,
          payment,
          refundPercentage,
          retryRefund: refundAmountMinor > 0,
        };
      });
    } finally {
      await session.endSession();
    }

    if (!result) throw new ServiceUnavailableException('Booking cancellation did not complete');
    if (result.conflict) throw new ConflictException(result.conflict);
    await this.releaseStripePayment(result.expireSessionId, result.cancelPaymentIntentId);
    if (result.retryRefund && result.payment) {
      result.payment = await this.processRefund(result.payment);
    }
    return {
      booking: result.booking,
      refundPercentage: result.refundPercentage,
      refundStatus: result.payment?.refundStatus ?? RefundStatus.NOT_REQUIRED,
      // Use this id with GET /refunds/:id (equals the payment id); null when nothing is refunded.
      refundId: result.payment ? this.refundIdFor(result.payment) : null,
    };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expirePendingBookings() {
    const now = new Date();
    const [hotelBookings, flightBookings] = await Promise.all([
      this.hotelBookingModel
        .find({
          status: HotelBookingStatus.PENDING_PAYMENT,
          holdExpiresAt: { $lte: now },
        })
        .select({ _id: 1 })
        .limit(EXPIRATION_BATCH_SIZE)
        .lean()
        .exec(),
      this.flightBookingModel
        .find({
          status: FlightBookingStatus.PENDING_PAYMENT,
          holdExpiresAt: { $lte: now },
        })
        .select({ _id: 1 })
        .limit(EXPIRATION_BATCH_SIZE)
        .lean()
        .exec(),
    ]);

    for (const booking of hotelBookings) {
      await this.expireBooking(PaymentBookingType.HOTEL, booking._id.toString(), now);
    }
    for (const booking of flightBookings) {
      await this.expireBooking(PaymentBookingType.FLIGHT, booking._id.toString(), now);
    }
  }

  /**
   * GEN-11 shared job: Confirmed -> Completed.
   * Hotel: once the check-out day has passed. Flight: once departure time has passed (not arrival),
   * so there is never a window where a departed flight is still cancellable (FLT-26).
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async completeFinishedBookings(now = new Date()) {
    assertBookingTransition(HotelBookingStatus.CONFIRMED, HotelBookingStatus.COMPLETED);
    assertBookingTransition(FlightBookingStatus.CONFIRMED, FlightBookingStatus.COMPLETED);
    const [hotels, flights] = await Promise.all([
      this.hotelBookingModel
        .updateMany(
          {
            status: HotelBookingStatus.CONFIRMED,
            checkOutDate: { $lte: new Date(now.getTime() - DAY_MS) },
          },
          { $set: { status: HotelBookingStatus.COMPLETED, completedAt: now } },
        )
        .exec(),
      this.flightBookingModel
        .updateMany(
          { status: FlightBookingStatus.CONFIRMED, departureTime: { $lte: now } },
          { $set: { status: FlightBookingStatus.COMPLETED, completedAt: now } },
        )
        .exec(),
    ]);
    return { hotels: hotels.modifiedCount, flights: flights.modifiedCount };
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryPendingRefunds() {
    const pending = await this.paymentModel
      .find({ refundStatus: RefundStatus.PENDING })
      .limit(EXPIRATION_BATCH_SIZE)
      .exec();
    for (const payment of pending) {
      await this.processRefund(payment);
    }
  }

  async expireFlightHoldsForInventory(inventoryId: Types.ObjectId) {
    const expired = await this.flightBookingModel
      .find({
        cabinInventoryId: inventoryId,
        status: FlightBookingStatus.PENDING_PAYMENT,
        holdExpiresAt: { $lte: new Date() },
      })
      .select({ _id: 1 })
      .lean()
      .exec();
    for (const booking of expired) {
      await this.expireBooking(
        PaymentBookingType.FLIGHT,
        booking._id.toString(),
        new Date(),
      );
    }
  }

  async expireFlightHoldsForUser(userId: string) {
    const expired = await this.flightBookingModel
      .find({
        userId: new Types.ObjectId(userId),
        status: FlightBookingStatus.PENDING_PAYMENT,
        holdExpiresAt: { $lte: new Date() },
      })
      .select({ _id: 1 })
      .lean()
      .exec();
    for (const booking of expired) {
      await this.expireBooking(
        PaymentBookingType.FLIGHT,
        booking._id.toString(),
        new Date(),
      );
    }
  }

  async expireFlightHold(bookingId: string) {
    if (!Types.ObjectId.isValid(bookingId)) return;
    await this.expireBooking(
      PaymentBookingType.FLIGHT,
      bookingId,
      new Date(),
    );
  }

  private async applyEvent(
    event: Stripe.Event,
    payment: Payment,
    session: ClientSession,
  ) {
    const object = event.data.object as Record<string, any>;
    if (event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded') {
      if (object.payment_status === 'paid' || event.type.endsWith('async_payment_succeeded')) {
        await this.applySuccessfulCheckout(object, payment, session);
      }
      return;
    }
    if (
      event.type === 'checkout.session.async_payment_failed' ||
      event.type === 'payment_intent.payment_failed'
    ) {
      if (payment.status !== PaymentStatus.SUCCEEDED) {
        payment.status = PaymentStatus.FAILED;
        payment.lastFailureCode =
          object.last_payment_error?.code ?? 'payment_failed';
        await this.persistPayment(payment, session);
      }
      return;
    }
    if (event.type === 'checkout.session.expired') {
      if (payment.status !== PaymentStatus.SUCCEEDED) {
        payment.status = PaymentStatus.EXPIRED;
        await this.persistPayment(payment, session);
        await this.expireBookingInTransaction(
          payment.bookingType,
          payment.bookingId,
          new Date(),
          session,
        );
      }
      return;
    }
    if (event.type === 'refund.updated') {
      await this.applyRefundUpdate(object, payment, session);
    }
  }

  private async applySuccessfulCheckout(
    checkout: Record<string, any>,
    payment: Payment,
    session: ClientSession,
  ) {
    if (typeof checkout.id !== 'string') return;
    if (
      payment.stripeCheckoutSessionId &&
      checkout.id !== payment.stripeCheckoutSessionId
    ) return;
    const paymentIntentId = this.asStripeId(checkout.payment_intent);
    const actualAmount = Number(checkout.amount_total);
    const actualCurrency = String(checkout.currency ?? '').toLowerCase();
    if (!paymentIntentId || !Number.isSafeInteger(actualAmount) || actualAmount <= 0) {
      return;
    }
    if (
      payment.status === PaymentStatus.SUCCEEDED ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED
    ) return;

    const metadataMatches =
      checkout.metadata?.paymentId === payment._id.toString() &&
      checkout.metadata?.bookingId === payment.bookingId.toString() &&
      checkout.metadata?.userId === payment.userId.toString() &&
      checkout.metadata?.bookingType === payment.bookingType &&
      (!checkout.mode || checkout.mode === 'payment');
    payment.stripeCheckoutSessionId ??= checkout.id;
    payment.stripePaymentIntentId = paymentIntentId;
    if (!metadataMatches) {
      payment.status = PaymentStatus.REFUND_PENDING;
      payment.refundAmountMinor = actualAmount;
      payment.refundPercentage = 100;
      payment.refundStatus = RefundStatus.PENDING;
      payment.refundRequestedAt = new Date();
      payment.lastFailureCode = 'checkout_metadata_mismatch';
      await this.persistPayment(payment, session);
      return;
    }

    const booking = await this.findOwnedBooking(
      payment.userId.toString(),
      payment.bookingType,
      payment.bookingId.toString(),
      session,
    );
    const now = new Date();
    const paymentMatches =
      actualAmount === payment.amountMinor &&
      actualCurrency === payment.currency.toLowerCase();
    const bookingIsPayable =
      booking?.status === this.pendingStatus(payment.bookingType) &&
      !!booking.holdExpiresAt &&
      booking.holdExpiresAt > now;

    if (bookingIsPayable && paymentMatches) {
      const confirmed = await this.updateBookingStatus(
        payment.bookingType,
        payment.bookingId,
        payment.userId.toString(),
        this.pendingStatus(payment.bookingType),
        this.confirmedStatus(payment.bookingType),
        now,
        session,
        true,
      );
      if (confirmed) {
        payment.status = PaymentStatus.SUCCEEDED;
        payment.stripePaymentIntentId = paymentIntentId;
        payment.lastFailureCode = undefined;
        await this.persistPayment(payment, session);
        return;
      }
    }

    if (booking?.status === this.pendingStatus(payment.bookingType)) {
      await this.expireBookingInTransaction(
        payment.bookingType,
        payment.bookingId,
        now,
        session,
        true,
      );
    }
    payment.status = PaymentStatus.REFUND_PENDING;
    payment.stripePaymentIntentId = paymentIntentId;
    payment.refundAmountMinor = actualAmount;
    payment.refundPercentage = 100;
    payment.refundStatus = RefundStatus.PENDING;
    payment.refundRequestedAt = now;
    if (!paymentMatches) payment.lastFailureCode = 'payment_amount_or_currency_mismatch';
    await this.persistPayment(payment, session);
  }

  private async findPaymentForEvent(
    event: Stripe.Event,
    session: ClientSession,
  ) {
    const object = event.data.object as Record<string, any>;
    let payment: Payment | null = null;
    const checkoutSessionId =
      typeof object.id === 'string' && object.id.startsWith('cs_')
        ? object.id
        : undefined;
    if (checkoutSessionId) {
      payment = await this.paymentModel
        .findOne({ stripeCheckoutSessionId: checkoutSessionId })
        .session(session)
        .exec();
    }
    const metadataPaymentId = object.metadata?.paymentId;
    if (!payment && metadataPaymentId && Types.ObjectId.isValid(metadataPaymentId)) {
      payment = await this.paymentModel
        .findById(metadataPaymentId)
        .session(session)
        .exec();
    }
    if (!payment && event.type === 'payment_intent.payment_failed') {
      payment = await this.paymentModel
        .findOne({ stripePaymentIntentId: object.id })
        .session(session)
        .exec();
    }
    return payment;
  }

  private async applyRefundUpdate(
    refund: Record<string, any>,
    payment: Payment,
    session: ClientSession,
  ) {
    if (
      payment.stripeRefundId &&
      refund.id !== payment.stripeRefundId
    ) {
      return;
    }
    if (refund.status === 'succeeded') {
      payment.stripeRefundId = refund.id;
      payment.refundAmountMinor = Number(refund.amount ?? payment.refundAmountMinor);
      payment.refundStatus = RefundStatus.SUCCEEDED;
      payment.refundedAt = new Date();
      payment.status =
        payment.refundAmountMinor >= payment.amountMinor
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED;
    } else if (refund.status === 'failed' || refund.status === 'canceled') {
      payment.stripeRefundId = refund.id;
      payment.refundStatus = RefundStatus.FAILED;
      payment.status = PaymentStatus.REFUND_FAILED;
    } else {
      payment.refundStatus = RefundStatus.PROCESSING;
      payment.status = PaymentStatus.REFUND_PENDING;
    }
    await this.persistPayment(payment, session);
  }

  private async processRefund(payment: Payment): Promise<Payment> {
    if (
      payment.refundAmountMinor <= 0 ||
      payment.refundStatus === RefundStatus.SUCCEEDED ||
      payment.refundStatus === RefundStatus.NOT_REQUIRED
    ) {
      return payment;
    }
    if (!payment.stripePaymentIntentId) {
      payment.refundStatus = RefundStatus.FAILED;
      payment.status = PaymentStatus.REFUND_FAILED;
      payment.lastFailureCode = 'missing_payment_intent';
      await this.persistPayment(payment);
      return payment;
    }

    try {
      const refund = await this.stripeService.createRefund({
        paymentIntentId: payment.stripePaymentIntentId,
        amountMinor: payment.refundAmountMinor,
        paymentId: payment._id.toString(),
        reason: 'booking_cancellation_or_expired_hold',
      });
      payment.stripeRefundId = refund.id;
      payment.refundAmountMinor = refund.amount;
      payment.refundStatus =
        refund.status === 'succeeded'
          ? RefundStatus.SUCCEEDED
          : refund.status === 'failed' || refund.status === 'canceled'
            ? RefundStatus.FAILED
            : RefundStatus.PROCESSING;
      payment.status =
        payment.refundStatus === RefundStatus.SUCCEEDED
          ? payment.refundAmountMinor >= payment.amountMinor
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED
          : payment.refundStatus === RefundStatus.FAILED
            ? PaymentStatus.REFUND_FAILED
            : PaymentStatus.REFUND_PENDING;
      if (payment.refundStatus === RefundStatus.SUCCEEDED) {
        payment.refundedAt = new Date();
      }
      payment.lastFailureCode = undefined;
      await this.persistPayment(payment);
    } catch {
      payment.refundStatus = RefundStatus.PENDING;
      payment.status = PaymentStatus.REFUND_PENDING;
      payment.lastFailureCode = 'stripe_refund_request_failed';
      await this.persistPayment(payment);
    }
    return payment;
  }

  private async expireBooking(
    bookingType: PaymentBookingType,
    bookingId: string,
    now: Date,
  ) {
    const session = await this.connection.startSession();
    let stripeSessionId: string | undefined;
    let stripePaymentIntentId: string | undefined;
    try {
      await session.withTransaction(async () => {
        const payment = await this.paymentModel
          .findOne({
            bookingType,
            bookingId: new Types.ObjectId(bookingId),
          })
          .session(session)
          .exec();
        const expired = await this.expireBookingInTransaction(
          bookingType,
          new Types.ObjectId(bookingId),
          now,
          session,
        );
        if (expired && payment) {
          stripeSessionId = payment.stripeCheckoutSessionId;
          if (payment.status !== PaymentStatus.SUCCEEDED) {
            stripePaymentIntentId = payment.stripePaymentIntentId;
          }
          if (payment.status !== PaymentStatus.SUCCEEDED) {
            payment.status = PaymentStatus.EXPIRED;
            await this.persistPayment(payment, session);
          }
        }
      });
    } finally {
      await session.endSession();
    }
    await this.releaseStripePayment(stripeSessionId, stripePaymentIntentId);
  }

  private async expireBookingInTransaction(
    bookingType: PaymentBookingType,
    bookingId: Types.ObjectId,
    now: Date,
    session: ClientSession,
    force = false,
  ) {
    assertBookingTransition(
      this.pendingStatus(bookingType),
      this.expiredStatus(bookingType),
    );
    if (bookingType === PaymentBookingType.HOTEL) {
      const expired = await this.hotelBookingModel
        .findOneAndUpdate(
          {
            _id: bookingId,
            status: HotelBookingStatus.PENDING_PAYMENT,
            ...(force ? {} : { holdExpiresAt: { $lte: now } }),
          },
          { $set: { status: HotelBookingStatus.EXPIRED } },
          { new: true, session },
        )
        .exec();
      return !!expired;
    }

    const expired = await this.flightBookingModel
      .findOneAndUpdate(
        {
          _id: bookingId,
          status: FlightBookingStatus.PENDING_PAYMENT,
          ...(force ? {} : { holdExpiresAt: { $lte: now } }),
        },
        { $set: { status: FlightBookingStatus.EXPIRED } },
        { new: true, session },
      )
      .exec();
    if (expired) {
      await this.inventoryModel
        .updateOne(
          { _id: expired.cabinInventoryId },
          { $inc: { availableSeats: expired.passengers.length } },
          { session },
        )
        .exec();
    }
    return !!expired;
  }

  private async releaseFlightSeats(
    booking: FlightBooking,
    session: ClientSession,
  ) {
    await this.inventoryModel
      .updateOne(
        { _id: booking.cabinInventoryId },
        { $inc: { availableSeats: booking.passengers.length } },
        { session },
      )
      .exec();
  }

  private async updateBookingStatus(
    bookingType: PaymentBookingType,
    bookingId: Types.ObjectId,
    userId: string,
    oldStatus: string,
    newStatus: string,
    now: Date,
    session: ClientSession,
    clearHold = false,
  ): Promise<CheckoutBooking | null> {
    assertBookingTransition(oldStatus, newStatus);
    const update: Record<string, unknown> = {
      status: newStatus,
      ...(newStatus === this.cancelledStatus(bookingType)
        ? { cancelledAt: now }
        : {}),
      ...(clearHold ? { holdExpiresAt: null } : {}),
    };
    const filter = {
      _id: bookingId,
      userId: new Types.ObjectId(userId),
      status: oldStatus,
      ...(clearHold ? { holdExpiresAt: { $gt: now } } : {}),
    };
    if (bookingType === PaymentBookingType.HOTEL) {
      const updated = await this.hotelBookingModel
        .findOneAndUpdate(
          filter as never,
          { $set: update },
          { new: true, session },
        )
        .exec();
      return updated as unknown as CheckoutBooking | null;
    }
    const updated = await this.flightBookingModel
      .findOneAndUpdate(
        filter as never,
        { $set: update },
        { new: true, session },
      )
      .exec();
    return updated as unknown as CheckoutBooking | null;
  }

  private async findOwnedBooking(
    userId: string,
    bookingType: PaymentBookingType,
    bookingId: string,
    session?: ClientSession,
  ): Promise<CheckoutBooking | null> {
    const filter = {
      _id: new Types.ObjectId(bookingId),
      userId: new Types.ObjectId(userId),
    };
    if (bookingType === PaymentBookingType.HOTEL) {
      const query = this.hotelBookingModel.findOne(filter);
      if (session) query.session(session);
      return query.lean().exec() as Promise<CheckoutBooking | null>;
    }
    const query = this.flightBookingModel.findOne(filter);
    if (session) query.session(session);
    return query.lean().exec() as Promise<CheckoutBooking | null>;
  }

  private getCancellationRefundPercentage(
    bookingType: PaymentBookingType,
    booking: HotelBooking | FlightBooking,
    now: Date,
  ) {
    const checkInOrDeparture =
      bookingType === PaymentBookingType.HOTEL
        ? (booking as HotelBooking).checkInDate
        : (booking as FlightBooking & { departureTime?: Date }).departureTime;
    const tiers =
      bookingType === PaymentBookingType.HOTEL
        ? (booking as HotelBooking).cancellationTiers.map((tier) => ({
            daysBefore: tier.daysBeforeCheckIn,
            refundPercentage: tier.refundPercentage,
          }))
        : (booking as FlightBooking).cancellationTiers.map((tier) => ({
            daysBefore: tier.daysBeforeDeparture,
            refundPercentage: tier.refundPercentage,
          }));
    if (!checkInOrDeparture) return 0;
    const remainingDays = Math.floor(
      (this.utcDay(checkInOrDeparture).getTime() - this.utcDay(now).getTime()) /
        86_400_000,
    );
    return (
      [...tiers]
        .sort((left, right) => right.daysBefore - left.daysBefore)
        .find((tier) => remainingDays >= tier.daysBefore)?.refundPercentage ?? 0
    );
  }

  private pendingStatus(bookingType: PaymentBookingType) {
    return bookingType === PaymentBookingType.HOTEL
      ? HotelBookingStatus.PENDING_PAYMENT
      : FlightBookingStatus.PENDING_PAYMENT;
  }

  private confirmedStatus(bookingType: PaymentBookingType) {
    return bookingType === PaymentBookingType.HOTEL
      ? HotelBookingStatus.CONFIRMED
      : FlightBookingStatus.CONFIRMED;
  }

  private cancelledStatus(bookingType: PaymentBookingType) {
    return bookingType === PaymentBookingType.HOTEL
      ? HotelBookingStatus.CANCELLED
      : FlightBookingStatus.CANCELLED;
  }

  private expiredStatus(bookingType: PaymentBookingType) {
    return bookingType === PaymentBookingType.HOTEL
      ? HotelBookingStatus.EXPIRED
      : FlightBookingStatus.EXPIRED;
  }

  /** Hotel: check-out day is over. Flight: departure time has passed (FLT-26). */
  private isFinished(
    bookingType: PaymentBookingType,
    booking: HotelBooking | FlightBooking,
    now: Date,
  ) {
    if (bookingType === PaymentBookingType.HOTEL) {
      const checkOut = (booking as HotelBooking).checkOutDate;
      return !!checkOut && checkOut.getTime() + DAY_MS <= now.getTime();
    }
    const departure = (booking as FlightBooking & { departureTime?: Date }).departureTime;
    return !!departure && departure.getTime() <= now.getTime();
  }

  /** Best effort: expire the Checkout Session and cancel its PaymentIntent (PAY-01). */
  private async releaseStripePayment(sessionId?: string, paymentIntentId?: string) {
    if (sessionId) await this.expireStripeSession(sessionId);
    if (paymentIntentId) {
      try {
        await this.stripeService.cancelPaymentIntent(paymentIntentId);
      } catch {
        this.logger.warn('A PaymentIntent could not be cancelled; webhook safeguards remain active');
      }
    }
  }

  private async expireStripeSession(sessionId: string) {
    try {
      await this.stripeService.expireCheckoutSession(sessionId);
    } catch {
      this.logger.warn('A Checkout Session could not be expired; webhook safeguards remain active');
    }
  }

  private checkoutResponse(payment: Payment) {
    return {
      paymentId: payment._id,
      checkoutSessionId: payment.stripeCheckoutSessionId,
      checkoutUrl: payment.stripeCheckoutUrl,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      holdExpiresAt: payment.holdExpiresAt,
      status: payment.status,
    };
  }

  private async persistPayment(payment: Payment, session?: ClientSession) {
    const fields = [
      'status',
      'holdExpiresAt',
      'stripeCheckoutSessionId',
      'stripeCheckoutUrl',
      'stripePaymentIntentId',
      'lastFailureCode',
      'refundAmountMinor',
      'refundPercentage',
      'refundStatus',
      'stripeRefundId',
      'refundRequestedAt',
      'refundedAt',
    ] as const;
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    for (const field of fields) {
      const value = payment[field];
      if (value === undefined) unset[field] = 1;
      else set[field] = value;
    }
    const update = {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    };
    return this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id },
        update,
        { new: true, ...(session ? { session } : {}) },
      )
      .exec();
  }

  private productName(type: PaymentBookingType, reference?: string) {
    const name = type === PaymentBookingType.HOTEL ? 'Hotel booking' : 'Flight booking';
    return reference ? `${name} ${reference}` : name;
  }

  private toMinorUnits(amount: number, currency: string) {
    const zeroDecimalCurrencies = new Set([
      'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
      'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
    ]);
    const exponent = zeroDecimalCurrencies.has(currency)
      ? 0
      : 2;
    const multiplier = 10 ** exponent;
    const amountMinor = Math.round(amount * multiplier);
    const isWholeUnitCurrency = currency === 'ISK' || currency === 'UGX';
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor < 1 ||
      Math.abs(amount * multiplier - amountMinor) > 1e-7 ||
      (isWholeUnitCurrency && !Number.isInteger(amount))
    ) {
      throw new ConflictException('The booking amount cannot be charged');
    }
    return amountMinor;
  }

  private utcDay(date: Date) {
    const day = new Date(date);
    day.setUTCHours(0, 0, 0, 0);
    return day;
  }

  private asStripeId(value: unknown) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'id' in value) {
      const id = (value as { id?: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  }

  private isDuplicateKeyError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
