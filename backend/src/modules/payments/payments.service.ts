import {

  BadRequestException,

  ConflictException,

  Inject,

  Injectable,

  Logger,

  Injectable,

  NotFoundException,

  UnauthorizedException,

  forwardRef,

} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { InjectModel } from '@nestjs/mongoose';

import { Model, Types } from 'mongoose';

import Stripe from 'stripe';

import { randomBytes } from 'crypto';

import { Payment } from './schemas/payment.schema';

import { PaymentStatus } from './enums/payment-status.enum';

import { RefundStatus } from './enums/refund-status.enum';

import {

  HotelBooking,

  HotelBookingStatus,

} from '../hotel-bookings/schemas/hotel-booking.schema';

import { FlightBookingsService } from '../flight-bookings/flight-bookings.service';
import { FlightBookingStatus } from '../flight-bookings/enums/flight-booking-status.enum';

@Injectable()

export class PaymentsService {

  private readonly stripe: Stripe;

  private readonly currency: string;

  constructor(

    private readonly configService: ConfigService,

    @InjectModel(Payment.name)

    private readonly paymentModel: Model<Payment>,

    @InjectModel(HotelBooking.name)

    private readonly bookingModel: Model<HotelBooking>,

    // FLT-23: The booking service owns flight status, reference and seats
    @Inject(forwardRef(() => FlightBookingsService))
    private readonly flightBookingsService: FlightBookingsService,

  ) {

    const secretKey =

      this.configService.get<string>('stripe.secretKey');

    if (!secretKey) {

      throw new Error('STRIPE_SECRET_KEY is not configured');

    }

    this.stripe = new Stripe(secretKey);

    this.currency =

      this.configService.get<string>('payments.currency') || 'egp';

  }

  // HTL-18: Expire unpaid hotel holds and cancel their Stripe PaymentIntents.
  @Cron(CronExpression.EVERY_MINUTE)
  async expireHotelPaymentHolds() {
    const expiredBookings = await this.bookingModel
      .find({
        status: {
          $in: [
            HotelBookingStatus.PENDING_PAYMENT,
            HotelBookingStatus.EXPIRED,
          ],
        },
        holdExpiresAt: { $lte: new Date() },
      })
      .exec();

    for (const booking of expiredBookings) {
      try {
        // Conditional update prevents overwriting a booking confirmed by a webhook.
        const expiredBooking = await this.bookingModel.findOneAndUpdate(
          {
            _id: booking._id,
            status: HotelBookingStatus.PENDING_PAYMENT,
            holdExpiresAt: { $lte: new Date() },
          },
          { $set: { status: HotelBookingStatus.EXPIRED } },
          { new: true },
        );

        // If it was already Expired, continue retrying any Stripe cancellation
        // that failed during an earlier scheduled run.
        if (!expiredBooking && booking.status !== HotelBookingStatus.EXPIRED) {
          continue;
        }

        const payments = await this.paymentModel
          .find({
            hotelBookingId: booking._id,
            status: { $in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
          })
          .exec();

        for (const payment of payments) {
          try {
            const intent = await this.stripe.paymentIntents.retrieve(
              payment.stripePaymentIntentId,
            );

            // A succeeded payment is handled by the webhook, which refunds it
            // because the associated reservation is already expired.
            if (intent.status === 'succeeded') continue;

            if (intent.status === 'canceled') {
              payment.status = PaymentStatus.CANCELLED;
              await payment.save();
              continue;
            }

            const cancelledIntent = await this.stripe.paymentIntents.cancel(
              intent.id,
            );

            if (cancelledIntent.status === 'canceled') {
              payment.status = PaymentStatus.CANCELLED;
              await payment.save();
            }
          } catch (error) {
            // Continue processing other payments; a later cron run can retry.
            console.error(
              `Could not cancel PaymentIntent for hotel booking ${booking._id}:`,
              error,
            );
          }
        }
      } catch (error) {
        console.error(`Could not expire hotel booking ${booking._id}:`, error);
      }
    }
  }

  // PAY-01 / PAY-02: Create or reuse a hotel PaymentIntent.

  async createHotelPayment(userId: string, bookingId: string) {

    if (

      !Types.ObjectId.isValid(userId) ||

      !Types.ObjectId.isValid(bookingId)

    ) {

      throw new BadRequestException('Invalid ID');

    }

    const booking = await this.bookingModel.findOne({

      _id: new Types.ObjectId(bookingId),

      userId: new Types.ObjectId(userId),

    });

    if (!booking) {

      throw new NotFoundException('Booking not found');

    }

    if (booking.status !== HotelBookingStatus.PENDING_PAYMENT) {

      throw new ConflictException(

        'This reservation is not awaiting payment',

      );

    }

    if (!booking.policiesAcceptedAt) {

      throw new ConflictException(

        'You must accept the hotel policies before payment',

      );

    }

    if (

      !booking.holdExpiresAt ||

      booking.holdExpiresAt.getTime() <= Date.now()

    ) {

      await this.bookingModel.updateOne(

        {

          _id: booking._id,

          status: HotelBookingStatus.PENDING_PAYMENT,

        },

        { $set: { status: HotelBookingStatus.EXPIRED } },

      );

      throw new ConflictException(

        'The 10-minute room hold has expired',

      );

    }

    const hotelPolicies = {

      checkInTime: booking.checkInTime,

      checkOutTime: booking.checkOutTime,

      cancellationTiers: booking.cancellationTiers,

      acceptedAt: booking.policiesAcceptedAt,

    };

    const amountInMinorUnits = Math.round(

      booking.totalPrice * 100,

    );

    if (amountInMinorUnits < 1) {

      throw new BadRequestException('Invalid payment amount');

    }

    const existingPayment = await this.paymentModel

      .findOne({

        hotelBookingId: booking._id,

        status: {

          $in: [PaymentStatus.PENDING, PaymentStatus.FAILED],

        },

      })

      .sort({ createdAt: -1 });

    if (existingPayment) {

      const existingIntent =

        await this.stripe.paymentIntents.retrieve(

          existingPayment.stripePaymentIntentId,

        );

      if (

        existingIntent.status !== 'canceled' &&

        existingIntent.status !== 'succeeded'

      ) {

        existingPayment.status = PaymentStatus.PENDING;

        await existingPayment.save();

        return {

          paymentIntentId: existingIntent.id,

          clientSecret: existingIntent.client_secret,

          amount: existingPayment.amount,

          currency: existingPayment.currency,

          hotelPolicies,

          holdExpiresAt: booking.holdExpiresAt,

        };

      }

      if (existingIntent.status === 'succeeded') {

        throw new ConflictException(

          'Payment has already succeeded. Waiting for confirmation.',

        );

      }

    }

    const paymentIntent =

      await this.stripe.paymentIntents.create(

        {

          amount: amountInMinorUnits,

          currency: this.currency,

          automatic_payment_methods: { enabled: true },

          metadata: {

            bookingId: booking._id.toString(),

            userId,

            bookingType: 'hotel',

          },

        },

        {

          idempotencyKey:

            `hotel-booking-${booking._id.toString()}-${randomBytes(8).toString('hex')}`,

        },

      );

    await this.paymentModel.create({

      userId: new Types.ObjectId(userId),

      hotelBookingId: booking._id,

      stripePaymentIntentId: paymentIntent.id,

      amount: booking.totalPrice,

      currency: this.currency,

      status: PaymentStatus.PENDING,

    });

    return {

      paymentIntentId: paymentIntent.id,

      clientSecret: paymentIntent.client_secret,

      amount: booking.totalPrice,

      currency: this.currency,

      hotelPolicies,

      holdExpiresAt: booking.holdExpiresAt,

    };

  }

  // PAY-01 / PAY-03: Process Stripe webhook events.

  async handleWebhook(rawBody: Buffer, signature: string) {

    const webhookSecret =

      this.configService.get<string>('stripe.webhookSecret');

    if (!webhookSecret) {

      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');

    }

    let event: Stripe.Event;

    try {

      event = this.stripe.webhooks.constructEvent(

        rawBody,

        signature,

        webhookSecret,

      );

    } catch {

      throw new UnauthorizedException(

        'Invalid Stripe webhook signature',

      );

    }

    switch (event.type) {

      case 'payment_intent.succeeded': {

        const intent = event.data.object as Stripe.PaymentIntent;

        // FLT-23: Flight intents carry bookingType 'flight' in metadata we set
        // ourselves (the event signature is already verified). Everything
        // else keeps the existing hotel path.
        if (intent.metadata?.bookingType === 'flight') {
          await this.confirmFlightPayment(intent);
        } else {
          await this.confirmHotelPayment(intent);
        }

        break;

      }

      case 'payment_intent.payment_failed': {

        const intent = event.data.object as Stripe.PaymentIntent;

        await this.paymentModel.updateOne(

          {

            stripePaymentIntentId: intent.id,

            status: PaymentStatus.PENDING,

          },

          { $set: { status: PaymentStatus.FAILED } },

        );

        break;

      }

      case 'payment_intent.canceled': {

        const intent = event.data.object as Stripe.PaymentIntent;

        await this.paymentModel.updateOne(

          { stripePaymentIntentId: intent.id },

          { $set: { status: PaymentStatus.CANCELLED } },

        );

        break;

      }

      case 'refund.updated': {

        const refund = event.data.object as Stripe.Refund;

        // Stripe may expand payment_intent into an object, or return null.
        // Look up by refund ID first, then fall back to its PaymentIntent ID.
        let payment = await this.paymentModel.findOne({
          stripeRefundId: refund.id,
        });

        const paymentIntentId =
          typeof refund.payment_intent === 'string'
            ? refund.payment_intent
            : refund.payment_intent?.id;

        if (!payment && paymentIntentId) {
          payment = await this.paymentModel.findOne({
            stripePaymentIntentId: paymentIntentId,
          });
        }

        if (payment) {
          payment.stripeRefundId = refund.id;

          if (refund.status === 'succeeded') {

            payment.refundStatus = RefundStatus.REFUNDED;

            if (

              refund.amount >= Math.round(payment.amount * 100)

            ) {

              payment.status = PaymentStatus.REFUNDED;

            }

          } else if (

            refund.status === 'failed' ||

            refund.status === 'canceled'

          ) {

            payment.refundStatus = RefundStatus.FAILED;

          } else {

            payment.refundStatus = RefundStatus.PENDING;

          }

          await payment.save();

        }

        break;

      }

      default:

        break;

    }

    return { received: true };

  }

  // HTL-17: Confirm reservation only after successful payment.

  private async confirmHotelPayment(

    intent: Stripe.PaymentIntent,

  ) {

    const payment = await this.paymentModel.findOne({

      stripePaymentIntentId: intent.id,

    });

    if (!payment) {

      throw new NotFoundException('Payment record not found');

    }

    if (

      payment.status === PaymentStatus.SUCCEEDED ||

      payment.status === PaymentStatus.REFUNDED

    ) {

      return;

    }

    const booking = await this.bookingModel.findById(

      payment.hotelBookingId,

    );

    if (!booking) {

      throw new NotFoundException('Hotel booking not found');

    }

    if (

      intent.amount !== Math.round(payment.amount * 100) ||

      intent.currency.toLowerCase() !==

        payment.currency.toLowerCase()

    ) {

      throw new BadRequestException(

        'Stripe payment amount or currency does not match the booking',

      );

    }

    // Never confirm a booking after its hold has expired.

    if (

      booking.status !== HotelBookingStatus.PENDING_PAYMENT ||

      !booking.holdExpiresAt ||

      booking.holdExpiresAt.getTime() <= Date.now()

    ) {

      await this.bookingModel.updateOne(

        {

          _id: booking._id,

          status: HotelBookingStatus.PENDING_PAYMENT,

        },

        { $set: { status: HotelBookingStatus.EXPIRED } },

      );

      const refund = await this.stripe.refunds.create(

        { payment_intent: intent.id },

        {

          idempotencyKey: `late-payment-refund-${intent.id}`,

        },

      );

      payment.stripeRefundId = refund.id;

      payment.refundStatus =

        refund.status === 'succeeded'

          ? RefundStatus.REFUNDED

          : RefundStatus.PENDING;

      payment.status =

        refund.status === 'succeeded'

          ? PaymentStatus.REFUNDED

          : PaymentStatus.PENDING;

      await payment.save();

      return;

    }

    const reference = `HTL-${randomBytes(6)

      .toString('hex')

      .toUpperCase()}`;

    const confirmedBooking =

      await this.bookingModel.findOneAndUpdate(

        {

          _id: booking._id,

          status: HotelBookingStatus.PENDING_PAYMENT,

          holdExpiresAt: { $gt: new Date() },

        },

        {

          $set: {

            status: HotelBookingStatus.CONFIRMED,

            reference,

            holdExpiresAt: null,

          },

        },

        { new: true },

      );

    if (!confirmedBooking) {

      throw new ConflictException(

        'Booking could not be confirmed because its hold expired or changed',

      );

    }

    payment.status = PaymentStatus.SUCCEEDED;

    await payment.save();

  }

  // HTL-21 / PAY-03: Cancel booking and process or retry its refund.

  async cancelHotelBooking(userId: string, bookingId: string) {

    if (

      !Types.ObjectId.isValid(userId) ||

      !Types.ObjectId.isValid(bookingId)

    ) {

      throw new BadRequestException('Invalid ID');

    }

    const booking = await this.bookingModel.findOne({

      _id: new Types.ObjectId(bookingId),

      userId: new Types.ObjectId(userId),

    });

    if (!booking) {

      throw new NotFoundException('Booking not found');

    }

    const payment = await this.paymentModel.findOne({

      hotelBookingId: booking._id,

    });

    if (!payment) {

      throw new NotFoundException('Payment record not found');

    }

    const retryingRefund =

      booking.status === HotelBookingStatus.CANCELLED &&

      payment.refundStatus === RefundStatus.FAILED;

    if (

      booking.status !== HotelBookingStatus.CONFIRMED &&

      !retryingRefund

    ) {

      throw new ConflictException(

        'Only confirmed bookings or bookings with failed refunds can be processed',

      );

    }

    if (!retryingRefund) {

      if (booking.checkInDate.getTime() <= Date.now()) {

        throw new ConflictException(

          'A booking cannot be cancelled on or after check-in',

        );

      }

      if (payment.status !== PaymentStatus.SUCCEEDED) {

        throw new ConflictException(

          'A successful payment is required before cancellation',

        );

      }

    }

    const daysBeforeCheckIn = Math.floor(

      (booking.checkInDate.getTime() - Date.now()) /

        (24 * 60 * 60 * 1000),

    );

    const applicableTier = [...(booking.cancellationTiers || [])]

      .filter(

        (tier) =>

          tier.daysBeforeCheckIn <= daysBeforeCheckIn,

      )

      .sort(

        (a, b) =>

          b.daysBeforeCheckIn - a.daysBeforeCheckIn,

      )[0];

    const refundPercentage =

      applicableTier?.refundPercentage ?? 0;

    const refundAmount = Number(

      (payment.amount * refundPercentage / 100).toFixed(2),

    );

    if (!retryingRefund) {

      const cancelledBooking =

        await this.bookingModel.findOneAndUpdate(

          {

            _id: booking._id,

            userId: new Types.ObjectId(userId),

            status: HotelBookingStatus.CONFIRMED,

            checkInDate: { $gt: new Date() },

          },

          {

            $set: {

              status: HotelBookingStatus.CANCELLED,

              cancelledAt: new Date(),

            },

          },

          { new: true },

        );

      if (!cancelledBooking) {

        throw new ConflictException(

          'Booking could not be cancelled. It may already be cancelled or check-in may have started.',

        );

      }

    }

    if (refundAmount <= 0) {

      return {

        message: 'Booking cancelled successfully. No refund is applicable.',

        bookingId: booking._id,

        status: HotelBookingStatus.CANCELLED,

        refundPercentage,

        refundAmount: 0,

        currency: payment.currency,

      };

    }

    const refundInMinorUnits = Math.round(

      refundAmount * 100,

    );

    payment.refundStatus = RefundStatus.PENDING;

    await payment.save();

    try {

      const refund = await this.stripe.refunds.create(

        {

          payment_intent: payment.stripePaymentIntentId,

          amount: refundInMinorUnits,

          metadata: {

            bookingId: booking._id.toString(),

            userId,

            refundPercentage: refundPercentage.toString(),

          },

        },

        {

          idempotencyKey: payment.stripeRefundId
            ? `hotel-refund-${booking._id.toString()}-retry-${payment.stripeRefundId}`
            : `hotel-refund-${booking._id.toString()}-initial`,

        },

      );

      payment.stripeRefundId = refund.id;

      payment.refundStatus =

        refund.status === 'succeeded'

          ? RefundStatus.REFUNDED

          : RefundStatus.PENDING;

      if (

        refund.status === 'succeeded' &&

        refundInMinorUnits >= Math.round(payment.amount * 100)

      ) {

        payment.status = PaymentStatus.REFUNDED;

      }

      await payment.save();

      return {

        message: 'Booking cancellation processed',

        bookingId: booking._id,

        status: HotelBookingStatus.CANCELLED,

        refundPercentage,

        refundAmount,

        currency: payment.currency,

        refundStatus: payment.refundStatus,

        stripeRefundId: refund.id,

      };

    } catch {
      // Keep Pending when the API outcome is uncertain. Stripe's refund.updated
      // webhook will mark it Failed if Stripe confirms that the refund failed.
      payment.refundStatus = RefundStatus.PENDING;
      await payment.save();

      throw new BadRequestException(
        'Booking was cancelled, but the refund is still being processed. Check the refund status before retrying.',
      );
    }

  }

  // ===========================================================================
  // FLT-23 / FLT-26 / PAY-01..04: Flight payments.
  // Everything below is flight-only; the hotel methods above are unchanged.
  // The flight booking service owns status transitions, reference and seats.
  // ===========================================================================

  private readonly flightLogger = new Logger('FlightPayments');

  // PAY-01 / PAY-02 / PAY-04: Create or reuse a flight PaymentIntent. Calling
  // it again is the retry, until the hold expires.
  async createFlightPayment(userId: string, bookingId: string) {
    // Owner, Pending Payment, live hold, accepted policies and platform
    // currency are all checked by the booking service.
    const booking = await this.flightBookingsService.getPayableBooking(
      userId,
      bookingId,
    );

    // PAY-04: Checked again here, case-insensitively
    if (booking.currency.toLowerCase() !== this.currency.toLowerCase()) {
      throw new ConflictException(
        'The booking currency does not match the platform payment currency',
      );
    }

    const amountInMinorUnits = Math.round(booking.totalPrice * 100);

    if (amountInMinorUnits < 1) {
      throw new BadRequestException('Invalid payment amount');
    }

    const flightBookingId = new Types.ObjectId(bookingId);

    // Never start a second payment for a booking that is already paid
    const alreadyPaid = await this.paymentModel
      .findOne({
        flightBookingId,
        status: { $in: [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED] },
      })
      .exec();

    if (alreadyPaid) {
      throw new ConflictException(
        'Payment has already succeeded. Waiting for confirmation.',
      );
    }

    const response = (paymentIntentId: string, clientSecret: string | null) => ({
      paymentIntentId,
      clientSecret,
      amount: booking.totalPrice,
      currency: this.currency,
      holdExpiresAt: booking.holdExpiresAt,
      policiesAcceptedAt: booking.policiesAcceptedAt,
    });

    // Retry: reuse the latest open PaymentIntent
    const existingPayment = await this.paymentModel
      .findOne({
        flightBookingId,
        status: { $in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      })
      .sort({ createdAt: -1 })
      .exec();

    if (existingPayment) {
      const existingIntent = await this.stripe.paymentIntents.retrieve(
        existingPayment.stripePaymentIntentId,
      );

      if (existingIntent.status === 'succeeded') {
        throw new ConflictException(
          'Payment has already succeeded. Waiting for confirmation.',
        );
      }

      if (
        existingIntent.status !== 'canceled' &&
        existingIntent.amount === amountInMinorUnits
      ) {
        await this.paymentModel
          .updateOne(
            { _id: existingPayment._id },
            { $set: { status: PaymentStatus.PENDING } },
          )
          .exec();

        return response(existingIntent.id, existingIntent.client_secret);
      }
    }

    const paymentIntent = await this.stripe.paymentIntents.create(
      {
        amount: amountInMinorUnits,
        currency: this.currency,
        automatic_payment_methods: { enabled: true },
        metadata: {
          bookingId,
          userId,
          bookingType: 'flight',
        },
      },
      {
        idempotencyKey: `flight-booking-${bookingId}-${randomBytes(8).toString('hex')}`,
      },
    );

    // PAY-01: Only the Stripe payment ID, amount, currency and status
    await this.paymentModel.create({
      userId: new Types.ObjectId(userId),
      bookingType: 'flight',
      flightBookingId,
      stripePaymentIntentId: paymentIntent.id,
      amount: booking.totalPrice,
      currency: this.currency,
      status: PaymentStatus.PENDING,
    });

    return response(paymentIntent.id, paymentIntent.client_secret);
  }

  // FLT-23: payment_intent.succeeded for a flight booking (signature verified)
  private async confirmFlightPayment(intent: Stripe.PaymentIntent) {
    const payment = await this.paymentModel
      .findOne({ stripePaymentIntentId: intent.id })
      .exec();

    if (!payment) {
      throw new NotFoundException('Payment record not found');
    }

    if (
      payment.bookingType !== 'flight' ||
      !payment.flightBookingId ||
      intent.metadata?.bookingId !== payment.flightBookingId.toString()
    ) {
      throw new BadRequestException(
        'Stripe payment does not match a flight booking',
      );
    }

    if (
      intent.amount !== Math.round(payment.amount * 100) ||
      intent.currency.toLowerCase() !== payment.currency.toLowerCase()
    ) {
      throw new BadRequestException(
        'Stripe payment amount or currency does not match the booking',
      );
    }

    // Already refunded: nothing more to do
    if (payment.status === PaymentStatus.REFUNDED) {
      return;
    }

    const bookingId = payment.flightBookingId.toString();

    if (payment.status !== PaymentStatus.SUCCEEDED) {
      // Status-guarded: a concurrent duplicate delivery finds nothing to update
      const marked = await this.paymentModel
        .findOneAndUpdate(
          {
            _id: payment._id,
            status: { $in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
          },
          { $set: { status: PaymentStatus.SUCCEEDED } },
          { new: true },
        )
        .exec();

      if (!marked) {
        return;
      }
    }

    const finished = [
      FlightBookingStatus.CONFIRMED,
      FlightBookingStatus.COMPLETED,
      FlightBookingStatus.CANCELLED,
    ];

    // Duplicate delivery after a successful confirmation
    const before = await this.flightBookingsService.getBookingStatus(bookingId);

    if (before && finished.includes(before)) {
      return;
    }

    if (before === FlightBookingStatus.PENDING_PAYMENT) {
      try {
        // Booking service: Pending -> Confirmed, reference, seats kept
        await this.flightBookingsService.confirmBooking(bookingId);
        return;
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          throw error;
        }
      }
    }

    // Re-check: a concurrent delivery may have confirmed it in between
    const after = await this.flightBookingsService.getBookingStatus(bookingId);

    if (after && finished.includes(after)) {
      return;
    }

    // PAY-01: The hold expired before the payment succeeded -> full refund.
    // The booking stays Expired.
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: intent.id,
        metadata: { bookingId, bookingType: 'flight', reason: 'hold_expired' },
      },
      { idempotencyKey: `flight-late-payment-refund-${intent.id}` },
    );

    await this.paymentModel
      .updateOne(
        { _id: payment._id },
        {
          $set: {
            stripeRefundId: refund.id,
            refundStatus: this.toRefundStatus(refund.status),
            ...(refund.status === 'succeeded'
              ? { status: PaymentStatus.REFUNDED }
              : {}),
          },
        },
      )
      .exec();

    // TODO(GEN-01): Notify the user that the late payment was refunded.
  }

  // FLT-23: Used by the booking service before it confirms
  async verifyFlightPayment(bookingId: string) {
    const payment = await this.paymentModel
      .findOne({
        flightBookingId: new Types.ObjectId(bookingId),
        status: PaymentStatus.SUCCEEDED,
      })
      .sort({ createdAt: -1 })
      .exec();

    return {
      succeeded: !!payment,
      paymentId: payment?.stripePaymentIntentId,
    };
  }

  // FLT-26 / FLT-06 / PAY-03: Refund a flight payment (partial or full).
  async refundFlightPayment(
    bookingId: string,
    amount: number,
  ): Promise<{ status: 'Refunded' | 'Pending' | 'Failed'; refundId?: string }> {
    const payment = await this.paymentModel
      .findOne({
        flightBookingId: new Types.ObjectId(bookingId),
        status: { $in: [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED] },
      })
      .sort({ createdAt: -1 })
      .exec();

    if (!payment) {
      throw new ConflictException(
        'No successful payment was found for this booking',
      );
    }

    if (payment.refundStatus === RefundStatus.REFUNDED) {
      return { status: 'Refunded', refundId: payment.stripeRefundId };
    }

    const amountInMinorUnits = Math.round(amount * 100);

    if (
      amountInMinorUnits < 1 ||
      amountInMinorUnits > Math.round(payment.amount * 100)
    ) {
      throw new BadRequestException('Invalid refund amount');
    }

    try {
      // Reuse a refund Stripe already created for this booking (for example
      // when an earlier call timed out), so a retry never refunds twice.
      const existing = await this.stripe.refunds.list({
        payment_intent: payment.stripePaymentIntentId,
        limit: 20,
      });

      let refund = existing.data.find(
        (candidate) =>
          candidate.metadata?.bookingId === bookingId &&
          candidate.status !== 'failed' &&
          candidate.status !== 'canceled',
      );

      if (!refund) {
        refund = await this.stripe.refunds.create(
          {
            payment_intent: payment.stripePaymentIntentId,
            amount: amountInMinorUnits,
            metadata: { bookingId, bookingType: 'flight' },
          },
          {
            idempotencyKey: `flight-refund-${bookingId}-${amountInMinorUnits}-${payment.stripeRefundId ?? 'initial'}`,
          },
        );
      }

      const refundStatus = this.toRefundStatus(refund.status);

      await this.paymentModel
        .updateOne(
          { _id: payment._id },
          {
            $set: {
              stripeRefundId: refund.id,
              refundStatus,
              ...(refundStatus === RefundStatus.REFUNDED &&
              refund.amount >= Math.round(payment.amount * 100)
                ? { status: PaymentStatus.REFUNDED }
                : {}),
            },
          },
        )
        .exec();

      // TODO(GEN-01): Notify the user about the refund.

      return {
        status:
          refundStatus === RefundStatus.REFUNDED
            ? 'Refunded'
            : refundStatus === RefundStatus.FAILED
              ? 'Failed'
              : 'Pending',
        refundId: refund.id,
      };
    } catch (error) {
      // Mark Failed so the user can retry; the retry reuses any refund Stripe
      // did create, so it cannot double-refund.
      await this.paymentModel
        .updateOne(
          { _id: payment._id },
          { $set: { refundStatus: RefundStatus.FAILED } },
        )
        .exec();

      throw error;
    }
  }

  // PAY-01: Cancel open PaymentIntents of an expired flight booking (best
  // effort; the webhook refunds any payment that still succeeds).
  async cancelFlightPaymentIntents(bookingId: string): Promise<void> {
    const payments = await this.paymentModel
      .find({
        flightBookingId: new Types.ObjectId(bookingId),
        status: { $in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      })
      .exec();

    for (const payment of payments) {
      try {
        const intent = await this.stripe.paymentIntents.retrieve(
          payment.stripePaymentIntentId,
        );

        if (intent.status === 'succeeded') continue;

        const cancelled =
          intent.status === 'canceled'
            ? intent
            : await this.stripe.paymentIntents.cancel(intent.id);

        if (cancelled.status === 'canceled') {
          await this.paymentModel
            .updateOne(
              { _id: payment._id },
              { $set: { status: PaymentStatus.CANCELLED } },
            )
            .exec();
        }
      } catch (error) {
        this.flightLogger.error(
          `Could not cancel PaymentIntent for flight booking ${bookingId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  // PAY-01 / PAY-03: Latest payment of a flight booking, for booking details
  async getFlightPaymentSummary(bookingId: string) {
    const payment = await this.paymentModel
      .findOne({ flightBookingId: new Types.ObjectId(bookingId) })
      .sort({ createdAt: -1 })
      .exec();

    if (!payment) {
      return null;
    }

    return {
      paymentIntentId: payment.stripePaymentIntentId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      refundStatus: payment.refundStatus ?? null,
      refundId: payment.stripeRefundId ?? null,
    };
  }

  private toRefundStatus(status: string | null): RefundStatus {
    if (status === 'succeeded') return RefundStatus.REFUNDED;
    if (status === 'failed' || status === 'canceled') return RefundStatus.FAILED;
    return RefundStatus.PENDING;
  }

}
