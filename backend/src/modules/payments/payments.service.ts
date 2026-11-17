import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { CreatePaymentDto } from './dto/payments.dto';
import { PlatformCurrencyService } from '../../common/currency/platform-currency.service';
import { TEST_PAYMENT_METHODS, isTestConfirmEnabled } from './test-mode';

const EXPIRATION_BATCH_SIZE = 100;
/** PaymentIntent states in which the customer can still (re)submit a payment method. */
const USABLE_INTENT_STATUSES = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);
const DAY_MS = 86_400_000;

type OwnedBooking = (HotelBooking | FlightBooking) & {
  _id: Types.ObjectId;
};

type CancellationResult = {
  booking: HotelBooking | FlightBooking;
  payment?: Payment | null;
  refundPercentage: number;
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
    private readonly platformCurrency: PlatformCurrencyService,
    private readonly config: ConfigService,
  ) {}

  /**
   * PAY-01: opens (or returns the open) PaymentIntent of a Pending Payment booking. The amount and
   * currency come from the booking, never from the client. The booking is confirmed only by the
   * signed webhook (handleStripeWebhook), never here.
   */
  async createPayment(userId: string, dto: CreatePaymentDto) {
    const { booking, amountMinor, currency } = await this.loadPayableBooking(
      userId,
      dto.bookingType,
      dto.bookingId,
    );
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
    if (payment.status === PaymentStatus.FAILED) {
      throw new ConflictException(
        'The last payment attempt failed. Use POST /payments/:id/retry to try again',
      );
    }
    if (payment.status !== PaymentStatus.PENDING) {
      throw new ConflictException('This booking already has a completed payment');
    }

    if (payment.stripePaymentIntentId) {
      const intent = await this.stripeService.retrievePaymentIntent(payment.stripePaymentIntentId);
      if (!USABLE_INTENT_STATUSES.has(intent.status)) {
        throw new ConflictException(
          `The payment is ${intent.status} and cannot be paid again. Check GET /payments/:id`,
        );
      }
      return this.paymentResponse(payment, intent.client_secret, booking.totalPrice, currency);
    }

    const intent = await this.createIntent(payment, userId, booking, `pi-${payment._id.toString()}`);
    const updated = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id },
        { $set: { stripePaymentIntentId: intent.id } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new ServiceUnavailableException('The PaymentIntent was created but could not be recorded');
    }
    return this.paymentResponse(updated, intent.client_secret, booking.totalPrice, currency);
  }

  /**
   * PAY-01: after a FAILED attempt the user may try again while the hold is valid. The same
   * PaymentIntent is reused while Stripe says it can still take a payment method; a cancelled one
   * is replaced by a new one (idempotency key derived from the old id, so double clicks agree).
   */
  async retryPayment(userId: string, paymentId: string) {
    const payment = await this.findOwnedPayment(userId, paymentId);
    if (payment.status !== PaymentStatus.FAILED) {
      throw new ConflictException('Only a payment whose last attempt failed can be retried');
    }
    const { booking, currency } = await this.loadPayableBooking(
      userId,
      payment.bookingType,
      payment.bookingId.toString(),
    );
    if (!payment.stripePaymentIntentId) {
      throw new ConflictException('This payment has no PaymentIntent to retry');
    }

    const previous = await this.stripeService.retrievePaymentIntent(payment.stripePaymentIntentId);
    let intent: Stripe.PaymentIntent;
    if (USABLE_INTENT_STATUSES.has(previous.status)) {
      intent = previous;
    } else if (previous.status === 'canceled') {
      intent = await this.createIntent(
        payment,
        userId,
        booking,
        `pi-${payment._id.toString()}-after-${previous.id}`,
      );
    } else {
      throw new ConflictException(`The PaymentIntent is ${previous.status} and cannot be retried`);
    }

    const updated = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id, status: { $in: [PaymentStatus.FAILED, PaymentStatus.PENDING] } },
        { $set: { status: PaymentStatus.PENDING, stripePaymentIntentId: intent.id }, $unset: { lastFailureCode: 1 } },
        { new: true },
      )
      .exec();
    if (!updated) throw new ConflictException('The payment changed while it was being retried');
    return this.paymentResponse(updated, intent.client_secret, booking.totalPrice, currency);
  }

  /**
   * Swagger/grader convenience: confirms the PaymentIntent on the server with a Stripe TEST card,
   * because nobody can type a card into Stripe Elements there. It does NOT confirm the booking:
   * that still happens only when Stripe's signed webhook arrives, like a real payment.
   * Answers 404 unless the key is sk_test_ and NODE_ENV is not production.
   */
  async testConfirm(userId: string, paymentId: string, outcome: 'success' | 'decline' = 'success') {
    if (
      !isTestConfirmEnabled(
        this.config.get<string>('stripe.secretKey'),
        this.config.get<string>('app.environment'),
      )
    ) {
      throw new NotFoundException();
    }
    const payment = await this.findOwnedPayment(userId, paymentId);
    await this.loadPayableBooking(userId, payment.bookingType, payment.bookingId.toString());
    if (
      !payment.stripePaymentIntentId ||
      (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.FAILED)
    ) {
      throw new ConflictException('This payment cannot be confirmed in its current state');
    }

    try {
      const intent = await this.stripeService.confirmPaymentIntent(
        payment.stripePaymentIntentId,
        TEST_PAYMENT_METHODS[outcome],
      );
      return {
        paymentId: payment._id,
        outcome: 'succeeded' as const,
        paymentIntentStatus: String(intent.status),
        note: 'The booking is confirmed only when Stripe\'s signed webhook arrives. Poll GET /payments/:id.',
      };
    } catch (error) {
      if ((error as { type?: string }).type === 'StripeCardError') {
        return {
          paymentId: payment._id,
          outcome: 'declined' as const,
          code: (error as { code?: string }).code ?? 'card_declined',
          note: 'The attempt failed. Use POST /payments/:id/retry, then test-confirm again.',
        };
      }
      this.logger.error(`Stripe rejected the test confirmation of payment ${payment._id.toString()}`);
      throw new BadGatewayException('Stripe rejected the test confirmation');
    }
  }

  private async findOwnedPayment(userId: string, paymentId: string): Promise<Payment & { _id: Types.ObjectId }> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(paymentId)) {
      throw new BadRequestException('Invalid user or payment ID');
    }
    const payment = await this.paymentModel
      .findOne({ _id: new Types.ObjectId(paymentId), userId: new Types.ObjectId(userId) })
      .exec();
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  /**
   * Shared gate of create / retry / test-confirm: the booking belongs to the user, is Pending Payment,
   * its hold is still valid, its policies are accepted (PAY-02) and its price is in the platform
   * currency (PAY-04). Returns the amount to charge, taken from the booking.
   */
  private async loadPayableBooking(userId: string, bookingType: PaymentBookingType, bookingId: string) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException('Invalid user or booking ID');
    }
    const booking = await this.findOwnedBooking(userId, bookingType, bookingId);
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== this.pendingStatus(bookingType)) {
      throw new ConflictException('Only bookings in Pending Payment can be paid');
    }
    const now = new Date();
    if (!booking.holdExpiresAt || booking.holdExpiresAt <= now) {
      await this.expireBooking(bookingType, booking._id.toString(), now);
      throw new ConflictException('The booking hold has expired');
    }
    if (!booking.policiesAcceptedAt) {
      throw new ConflictException(
        'You must accept the policies (POST /bookings/:type/:id/accept-policies) before paying',
      );
    }
    const currency = booking.currency?.trim().toUpperCase();
    if (!currency || currency !== this.platformCurrency.code) {
      throw new ConflictException(
        `The booking is not priced in the platform currency ${this.platformCurrency.code}`,
      );
    }
    return { booking, amountMinor: this.toMinorUnits(booking.totalPrice, currency), currency };
  }

  private createIntent(payment: Payment & { _id: Types.ObjectId }, userId: string, booking: OwnedBooking, idempotencyKey: string) {
    return this.stripeService.createPaymentIntent({
      paymentId: payment._id.toString(),
      bookingType: payment.bookingType,
      bookingId: booking._id.toString(),
      userId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      idempotencyKey,
    });
  }

  /** `clientSecret` is handed to Stripe Elements only: never stored, never logged. */
  private paymentResponse(
    payment: Payment & { _id: Types.ObjectId },
    clientSecret: string | null,
    amount: number,
    currency: string,
  ) {
    return {
      paymentId: payment._id,
      clientSecret,
      amount,
      amountMinor: payment.amountMinor,
      currency,
      status: payment.status,
      holdExpiresAt: payment.holdExpiresAt,
    };
  }

  async getForUser(userId: string, paymentId: string) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(paymentId)) {
      throw new BadRequestException('Invalid user or payment ID');
    }
    const payment = await this.paymentModel
      .findOne({ _id: paymentId, userId })
      .select({
        userId: 0,
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
    await this.releaseStripePayment(result.cancelPaymentIntentId);
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

  /** Expires a hold whose time is up (used by accept-policies, so a lapsed hold is released at once). */
  async expireHoldIfDue(bookingType: PaymentBookingType, bookingId: string) {
    await this.expireBooking(bookingType, bookingId, new Date());
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
    const object = event.data.object as unknown as Record<string, any>;
    switch (event.type) {
      case 'payment_intent.succeeded':
        return this.applyIntentSucceeded(object, payment, session);
      case 'payment_intent.payment_failed':
        return this.applyIntentFailed(object, payment, session);
      case 'refund.updated':
        return this.applyRefundUpdate(object, payment, session);
      default:
        return;
    }
  }

  /** The PaymentIntent of the event must be the one we created for this payment. */
  private isOurIntent(intent: Record<string, any>, payment: Payment, eventType: string) {
    if (typeof intent.id === 'string' && intent.id === payment.stripePaymentIntentId) return true;
    this.logger.error(
      `Ignored ${eventType}: PaymentIntent ${String(intent.id)} is not the PaymentIntent of payment ${payment._id.toString()}`,
    );
    return false;
  }

  /**
   * PAY-01: the ONLY place a booking becomes Confirmed. Requires the same PaymentIntent, the exact
   * booking amount and currency, and a booking that is still Pending Payment with a valid hold.
   * Anything else is NOT confirmed: the money was taken, so the payment is flagged Refund Pending
   * (the existing refund job returns it) and the reason is logged with ids only.
   */
  private async applyIntentSucceeded(
    intent: Record<string, any>,
    payment: Payment,
    session: ClientSession,
  ) {
    if (!this.isOurIntent(intent, payment, 'payment_intent.succeeded')) return;
    if (
      payment.status === PaymentStatus.SUCCEEDED ||
      payment.status === PaymentStatus.REFUND_PENDING ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED ||
      payment.status === PaymentStatus.REFUND_FAILED
    ) return;

    const actualAmount = Number(intent.amount_received ?? intent.amount);
    const actualCurrency = String(intent.currency ?? '').toLowerCase();
    if (!Number.isSafeInteger(actualAmount) || actualAmount <= 0) {
      this.logger.error(`Ignored payment_intent.succeeded for payment ${payment._id.toString()}: no valid amount`);
      return;
    }

    const booking = await this.findOwnedBooking(
      payment.userId.toString(),
      payment.bookingType,
      payment.bookingId.toString(),
      session,
    );
    const now = new Date();
    let bookingAmountMinor: number | null = null;
    try {
      if (booking) bookingAmountMinor = this.toMinorUnits(booking.totalPrice, booking.currency.toUpperCase());
    } catch {
      bookingAmountMinor = null;
    }
    const paymentMatches =
      !!booking &&
      actualAmount === payment.amountMinor &&
      actualAmount === bookingAmountMinor &&
      actualCurrency === payment.currency.toLowerCase() &&
      actualCurrency === booking.currency.toLowerCase();
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
    const reason = paymentMatches ? 'succeeded_after_hold_expiry' : 'payment_amount_or_currency_mismatch';
    this.logger.warn(
      `Payment ${payment._id.toString()} (${payment.bookingType} booking ${payment.bookingId.toString()}) was not confirmed: ${reason}. Flagged Refund Pending`,
    );
    payment.status = PaymentStatus.REFUND_PENDING;
    payment.refundAmountMinor = actualAmount;
    payment.refundPercentage = 100;
    payment.refundStatus = RefundStatus.PENDING;
    payment.refundRequestedAt = now;
    payment.lastFailureCode = reason;
    await this.persistPayment(payment, session);
  }

  /** A failed attempt keeps the booking Pending Payment so the user can retry until the hold expires. */
  private async applyIntentFailed(
    intent: Record<string, any>,
    payment: Payment,
    session: ClientSession,
  ) {
    if (!this.isOurIntent(intent, payment, 'payment_intent.payment_failed')) return;
    if (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.FAILED) return;
    payment.status = PaymentStatus.FAILED;
    payment.lastFailureCode = intent.last_payment_error?.code ?? 'payment_failed';
    await this.persistPayment(payment, session);
  }

  private async findPaymentForEvent(
    event: Stripe.Event,
    session: ClientSession,
  ) {
    const object = event.data.object as unknown as Record<string, any>;
    let payment: Payment | null = null;
    if (event.type.startsWith('payment_intent.') && typeof object.id === 'string') {
      payment = await this.paymentModel
        .findOne({ stripePaymentIntentId: object.id })
        .session(session)
        .exec();
    }
    const metadataPaymentId = object.metadata?.paymentId;
    if (!payment && metadataPaymentId && Types.ObjectId.isValid(metadataPaymentId)) {
      // The handlers still require the PaymentIntent id to match before they act.
      payment = await this.paymentModel
        .findById(metadataPaymentId)
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
        refundId: payment._id.toString(),
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
    await this.releaseStripePayment(stripePaymentIntentId);
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
  ): Promise<OwnedBooking | null> {
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
      return updated as unknown as OwnedBooking | null;
    }
    const updated = await this.flightBookingModel
      .findOneAndUpdate(
        filter as never,
        { $set: update },
        { new: true, session },
      )
      .exec();
    return updated as unknown as OwnedBooking | null;
  }

  private async findOwnedBooking(
    userId: string,
    bookingType: PaymentBookingType,
    bookingId: string,
    session?: ClientSession,
  ): Promise<OwnedBooking | null> {
    const filter = {
      _id: new Types.ObjectId(bookingId),
      userId: new Types.ObjectId(userId),
    };
    if (bookingType === PaymentBookingType.HOTEL) {
      const query = this.hotelBookingModel.findOne(filter);
      if (session) query.session(session);
      return query.lean().exec() as Promise<OwnedBooking | null>;
    }
    const query = this.flightBookingModel.findOne(filter);
    if (session) query.session(session);
    return query.lean().exec() as Promise<OwnedBooking | null>;
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

  /** Best effort: cancel the PaymentIntent of an unpaid booking whose hold ended (PAY-01). */
  private async releaseStripePayment(paymentIntentId?: string) {
    if (!paymentIntentId) return;
    try {
      await this.stripeService.cancelPaymentIntent(paymentIntentId);
    } catch {
      this.logger.warn(`PaymentIntent ${paymentIntentId} could not be cancelled; webhook safeguards remain active`);
    }
  }

  private async persistPayment(payment: Payment, session?: ClientSession) {
    const fields = [
      'status',
      'holdExpiresAt',
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

  private isDuplicateKeyError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
