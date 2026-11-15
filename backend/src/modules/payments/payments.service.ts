import {

  BadRequestException,

  ConflictException,

  Injectable,

  NotFoundException,

  UnauthorizedException,

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

        await this.confirmHotelPayment(intent);

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

}
