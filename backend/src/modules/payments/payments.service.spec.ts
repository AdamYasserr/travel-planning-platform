import { jest } from '@jest/globals';
import { Types } from 'mongoose';

import { FlightBookingStatus } from '../flight-bookings/enums/flight-booking-status.enum';
import { HotelBookingStatus } from '../hotel-bookings/schemas/hotel-booking.schema';
import {
  PaymentBookingType,
  PaymentStatus,
} from './enums/payment-status.enum';
import { RefundStatus } from './enums/refund-status.enum';
import { PaymentsService } from './payments.service';

function query(result: unknown) {
  const cursor = {
    exec: jest.fn(async () => result),
    lean: jest.fn(() => cursor),
    session: jest.fn(() => cursor),
    select: jest.fn(() => cursor),
    populate: jest.fn(() => cursor),
    sort: jest.fn(() => cursor),
    skip: jest.fn(() => cursor),
    limit: jest.fn(() => cursor),
  };
  return cursor;
}

describe('PaymentsService', () => {
  const userId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();
  const paymentId = new Types.ObjectId();

  let service: PaymentsService;
  let paymentModel: Record<string, ReturnType<typeof jest.fn>>;
  let webhookEventModel: Record<string, ReturnType<typeof jest.fn>>;
  let hotelBookingModel: Record<string, ReturnType<typeof jest.fn>>;
  let flightBookingModel: Record<string, ReturnType<typeof jest.fn>>;
  let inventoryModel: Record<string, ReturnType<typeof jest.fn>>;
  let stripeService: Record<string, ReturnType<typeof jest.fn>>;
  let connection: Record<string, ReturnType<typeof jest.fn>>;
  let payment: Record<string, any>;
  let hotelBooking: Record<string, any>;
  let flightBooking: Record<string, any>;

  function makeService() {
    service = new PaymentsService(
      paymentModel as never,
      webhookEventModel as never,
      hotelBookingModel as never,
      flightBookingModel as never,
      inventoryModel as never,
      connection as never,
      stripeService as never,
    );
  }

  function checkoutEvent(object: Record<string, any>, id = 'evt_paid') {
    return {
      id,
      type: 'checkout.session.completed',
      data: { object },
    } as never;
  }

  beforeEach(() => {
    payment = {
      _id: paymentId,
      userId,
      bookingType: PaymentBookingType.HOTEL,
      bookingId,
      amountMinor: 20000,
      currency: 'egp',
      status: PaymentStatus.PENDING,
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
      stripeCheckoutSessionId: 'cs_test_session',
      stripePaymentIntentId: undefined,
      refundAmountMinor: 0,
      refundPercentage: 0,
      refundStatus: RefundStatus.NOT_REQUIRED,
    };
    hotelBooking = {
      _id: bookingId,
      userId,
      status: HotelBookingStatus.PENDING_PAYMENT,
      totalPrice: 200,
      currency: 'EGP',
      reference: 'HTL-TEST',
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
      checkInDate: new Date(Date.now() + 60 * 86_400_000),
      cancellationTiers: [
        { daysBeforeCheckIn: 30, refundPercentage: 100 },
        { daysBeforeCheckIn: 0, refundPercentage: 0 },
      ],
    };
    flightBooking = {
      _id: bookingId,
      userId,
      status: FlightBookingStatus.PENDING_PAYMENT,
      totalPrice: 200,
      currency: 'egp',
      reference: 'FLT-TEST',
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
      departureTime: new Date(Date.now() + 60 * 86_400_000),
      cancellationTiers: [
        { daysBeforeDeparture: 30, refundPercentage: 75 },
        { daysBeforeDeparture: 0, refundPercentage: 0 },
      ],
      cabinInventoryId: new Types.ObjectId(),
      passengers: [{}, {}],
    };

    paymentModel = {
      findOneAndUpdate: jest.fn((_filter, update) => {
        Object.assign(
          payment,
          update.$setOnInsert ?? {},
          update.$set ?? {},
        );
        return query(payment);
      }),
      findOne: jest.fn(() => query(payment)),
      findById: jest.fn(() => query(payment)),
      find: jest.fn(() => query([])),
    };
    webhookEventModel = {
      findOne: jest.fn(() => query(null)),
      create: jest.fn(async () => [{
        paymentId: null,
        save: jest.fn(async () => undefined),
      }]),
    };
    hotelBookingModel = {
      findOne: jest.fn(() => query(hotelBooking)),
      findOneAndUpdate: jest.fn(() => query({
        ...hotelBooking,
        status: HotelBookingStatus.CONFIRMED,
      })),
      find: jest.fn(() => query([])),
    };
    flightBookingModel = {
      findOne: jest.fn(() => query(flightBooking)),
      findOneAndUpdate: jest.fn(() => query({
        ...flightBooking,
        status: FlightBookingStatus.CONFIRMED,
      })),
      find: jest.fn(() => query([])),
    };
    inventoryModel = {
      updateOne: jest.fn(() => query({ modifiedCount: 1 })),
    };
    stripeService = {
      constructWebhookEvent: jest.fn(() => checkoutEvent({})),
      createCheckoutSession: jest.fn(async () => ({
        id: 'cs_test_session',
        url: 'https://checkout.stripe.test/session',
      })),
      expireCheckoutSession: jest.fn(async () => undefined),
      cancelPaymentIntent: jest.fn(async () => undefined),
      createRefund: jest.fn(async () => ({
        id: 're_test_refund',
        amount: 20000,
        status: 'succeeded',
      })),
    };
    connection = {
      startSession: jest.fn(async () => ({
        withTransaction: async (callback: () => Promise<void>) => callback(),
        endSession: async () => undefined,
      })),
    };
    makeService();
  });

  it('creates checkout with backend-derived amount and currency', async () => {
    const response = await service.createCheckoutSession(userId.toString(), {
      bookingType: PaymentBookingType.HOTEL,
      bookingId: bookingId.toString(),
    });

    expect(stripeService.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: 20000,
        currency: 'egp',
        bookingId: bookingId.toString(),
        userId: userId.toString(),
      }),
    );
    expect(response).toMatchObject({
      checkoutUrl: 'https://checkout.stripe.test/session',
      amountMinor: 20000,
      currency: 'egp',
    });
  });

  it('rejects payment attempts for another user’s booking', async () => {
    hotelBookingModel.findOne = jest.fn(() => query(null));

    await expect(
      service.createCheckoutSession(new Types.ObjectId().toString(), {
        bookingType: PaymentBookingType.HOTEL,
        bookingId: bookingId.toString(),
      }),
    ).rejects.toThrow('Booking not found');
    expect(stripeService.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects a booking that is not pending payment', async () => {
    hotelBooking.status = HotelBookingStatus.CONFIRMED;

    await expect(
      service.createCheckoutSession(userId.toString(), {
        bookingType: PaymentBookingType.HOTEL,
        bookingId: bookingId.toString(),
      }),
    ).rejects.toThrow('Only pending bookings can be paid');
    expect(stripeService.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('reuses the existing session instead of creating a duplicate payment', async () => {
    payment.stripeCheckoutUrl = 'https://checkout.stripe.test/existing';

    const response = await service.createCheckoutSession(userId.toString(), {
      bookingType: PaymentBookingType.HOTEL,
      bookingId: bookingId.toString(),
    });

    expect(stripeService.createCheckoutSession).not.toHaveBeenCalled();
    expect(response.checkoutUrl).toBe('https://checkout.stripe.test/existing');
  });

  it('rejects webhook requests with an invalid signature', async () => {
    stripeService.constructWebhookEvent = jest.fn(() => {
      throw new Error('signature mismatch');
    });

    await expect(
      service.handleStripeWebhook(Buffer.from('{}'), 'invalid'),
    ).rejects.toThrow('Invalid Stripe webhook signature');
  });

  it('confirms only a verified paid Checkout Session', async () => {
    stripeService.constructWebhookEvent = jest.fn(() =>
      checkoutEvent({
        id: 'cs_test_session',
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
        amount_total: 20000,
        currency: 'egp',
        metadata: {
          paymentId: paymentId.toString(),
          bookingType: PaymentBookingType.HOTEL,
          bookingId: bookingId.toString(),
          userId: userId.toString(),
        },
      }),
    );

    await service.handleStripeWebhook(Buffer.from('{}'), 'signed');

    expect(hotelBookingModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: HotelBookingStatus.PENDING_PAYMENT,
        holdExpiresAt: expect.objectContaining({ $gt: expect.any(Date) }),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: HotelBookingStatus.CONFIRMED,
          holdExpiresAt: null,
        }),
      }),
      expect.objectContaining({ new: true }),
    );
    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(payment.stripePaymentIntentId).toBe('pi_test_1');
  });

  it('records payment failures without confirming the booking', async () => {
    stripeService.constructWebhookEvent = jest.fn(() => ({
      id: 'evt_failed',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_failed',
          last_payment_error: { code: 'card_declined' },
          metadata: { paymentId: paymentId.toString() },
        },
      },
    }) as never);

    await service.handleStripeWebhook(Buffer.from('{}'), 'signed');

    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.lastFailureCode).toBe('card_declined');
    expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('ignores duplicate successful webhook delivery after its first processing', async () => {
    payment.status = PaymentStatus.SUCCEEDED;
    webhookEventModel.findOne = jest.fn(() => query({
      paymentId,
      status: 'Processed',
    }));
    stripeService.constructWebhookEvent = jest.fn(() => checkoutEvent({}));

    await service.handleStripeWebhook(Buffer.from('{}'), 'signed');

    expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(stripeService.createRefund).not.toHaveBeenCalled();
  });

  it('refunds a successful payment when its booking hold already expired', async () => {
    hotelBooking.status = HotelBookingStatus.EXPIRED;
    hotelBooking.holdExpiresAt = new Date(Date.now() - 1000);
    stripeService.constructWebhookEvent = jest.fn(() =>
      checkoutEvent({
        id: 'cs_test_session',
        payment_status: 'paid',
        payment_intent: 'pi_test_late',
        amount_total: 20000,
        currency: 'egp',
        metadata: {
          paymentId: paymentId.toString(),
          bookingType: PaymentBookingType.HOTEL,
          bookingId: bookingId.toString(),
          userId: userId.toString(),
        },
      }),
    );

    await service.handleStripeWebhook(Buffer.from('{}'), 'signed');

    expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(stripeService.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_test_late',
        amountMinor: 20000,
      }),
    );
    expect(payment.status).toBe(PaymentStatus.REFUNDED);
  });

  it('expires the flight hold and restores seats before refunding a late payment', async () => {
    payment.bookingType = PaymentBookingType.FLIGHT;
    payment.status = PaymentStatus.PENDING;
    flightBooking.status = FlightBookingStatus.PENDING_PAYMENT;
    flightBooking.holdExpiresAt = new Date(Date.now() - 1000);
    flightBookingModel.findOneAndUpdate = jest.fn(() => query({
      ...flightBooking,
      status: FlightBookingStatus.EXPIRED,
    }));
    stripeService.constructWebhookEvent = jest.fn(() =>
      checkoutEvent({
        id: 'cs_test_session',
        payment_status: 'paid',
        payment_intent: 'pi_test_late_flight',
        amount_total: 20000,
        currency: 'egp',
        metadata: {
          paymentId: paymentId.toString(),
          bookingType: PaymentBookingType.FLIGHT,
          bookingId: bookingId.toString(),
          userId: userId.toString(),
        },
      }),
    );

    await service.handleStripeWebhook(Buffer.from('{}'), 'signed');

    expect(inventoryModel.updateOne).toHaveBeenCalledWith(
      { _id: flightBooking.cabinInventoryId },
      { $inc: { availableSeats: 2 } },
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(stripeService.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_test_late_flight' }),
    );
    expect(flightBookingModel.findOneAndUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: FlightBookingStatus.PENDING_PAYMENT }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: FlightBookingStatus.CONFIRMED }),
      }),
      expect.anything(),
    );
  });

  it('applies hotel cancellation tiers and records Stripe refund results', async () => {
    const checkInDate = new Date(Date.now() + 60 * 86_400_000);
    hotelBooking.status = HotelBookingStatus.CONFIRMED;
    hotelBooking.checkInDate = checkInDate;
    hotelBooking.cancellationTiers = [
      { daysBeforeCheckIn: 30, refundPercentage: 50 },
      { daysBeforeCheckIn: 0, refundPercentage: 0 },
    ];
    payment.status = PaymentStatus.SUCCEEDED;
    payment.stripePaymentIntentId = 'pi_test_1';
    stripeService.createRefund = jest.fn(async () => ({
      id: 're_test_partial',
      amount: 10000,
      status: 'succeeded',
    }));

    const result = await service.cancelBooking(
      userId.toString(),
      PaymentBookingType.HOTEL,
      bookingId.toString(),
    );

    expect(result.refundPercentage).toBe(50);
    expect(stripeService.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 10000 }),
    );
    expect(payment.refundAmountMinor).toBe(10000);
    expect(payment.refundStatus).toBe(RefundStatus.SUCCEEDED);
    expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
  });

  it('does not issue another refund after cancellation has already been refunded', async () => {
    hotelBooking.status = HotelBookingStatus.CANCELLED;
    payment.status = PaymentStatus.REFUNDED;
    payment.refundStatus = RefundStatus.SUCCEEDED;

    await service.cancelBooking(
      userId.toString(),
      PaymentBookingType.HOTEL,
      bookingId.toString(),
    );

    expect(stripeService.createRefund).not.toHaveBeenCalled();
    expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns flight seats when an unpaid flight hold is cancelled', async () => {
    flightBooking.status = FlightBookingStatus.PENDING_PAYMENT;
    paymentModel.findOne = jest.fn(() => query(null));
    flightBookingModel.findOneAndUpdate = jest.fn(() => query({
      ...flightBooking,
      status: FlightBookingStatus.EXPIRED,
    }));

    await service.cancelBooking(
      userId.toString(),
      PaymentBookingType.FLIGHT,
      bookingId.toString(),
    );

    expect(inventoryModel.updateOne).toHaveBeenCalledWith(
      { _id: flightBooking.cabinInventoryId },
      { $inc: { availableSeats: 2 } },
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(stripeService.createRefund).not.toHaveBeenCalled();
  });

  it('does not invent a flight refund when the booking has no policy snapshot', async () => {
    flightBooking.status = FlightBookingStatus.CONFIRMED;
    flightBooking.cancellationTiers = [];
    payment.status = PaymentStatus.SUCCEEDED;

    await expect(
      service.cancelBooking(
        userId.toString(),
        PaymentBookingType.FLIGHT,
        bookingId.toString(),
      ),
    ).rejects.toThrow('The airline cancellation policy is not configured');
    expect(flightBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(stripeService.createRefund).not.toHaveBeenCalled();
  });

  it('releases an unpaid hold as Expired (not Cancelled) and cancels the Stripe session and intent', async () => {
    payment.status = PaymentStatus.PENDING;
    payment.stripePaymentIntentId = 'pi_pending_1';
    hotelBookingModel.findOneAndUpdate = jest.fn(() =>
      query({ ...hotelBooking, status: HotelBookingStatus.EXPIRED }),
    );

    const result = await service.cancelBooking(
      userId.toString(),
      PaymentBookingType.HOTEL,
      bookingId.toString(),
    );

    const [filter, update] = hotelBookingModel.findOneAndUpdate.mock.calls[0] as any[];
    expect(filter.status).toBe(HotelBookingStatus.PENDING_PAYMENT);
    expect(update.$set.status).toBe(HotelBookingStatus.EXPIRED);
    expect(update.$set.cancelledAt).toBeUndefined();
    expect(payment.status).toBe(PaymentStatus.EXPIRED);
    expect(stripeService.expireCheckoutSession).toHaveBeenCalledWith('cs_test_session');
    expect(stripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_pending_1');
    expect(result.booking).toMatchObject({ status: HotelBookingStatus.EXPIRED });
  });

  it('does not cancel a PaymentIntent that already succeeded', async () => {
    payment.status = PaymentStatus.SUCCEEDED;
    payment.stripePaymentIntentId = 'pi_paid_1';

    await service.cancelBooking(
      userId.toString(),
      PaymentBookingType.HOTEL,
      bookingId.toString(),
    );

    expect(stripeService.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('refuses to cancel a confirmed flight after departure (FLT-26)', async () => {
    flightBooking.status = FlightBookingStatus.CONFIRMED;
    flightBooking.departureTime = new Date(Date.now() - 60_000);
    payment.status = PaymentStatus.SUCCEEDED;

    await expect(
      service.cancelBooking(
        userId.toString(),
        PaymentBookingType.FLIGHT,
        bookingId.toString(),
      ),
    ).rejects.toThrow('cannot be cancelled after departure');
    expect(flightBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(stripeService.createRefund).not.toHaveBeenCalled();
  });

  describe('completeFinishedBookings (GEN-11)', () => {
    it('completes confirmed flights past departure and hotels past the check-out day', async () => {
      const now = new Date('2030-06-10T12:00:00.000Z');
      hotelBookingModel.updateMany = jest.fn(() => query({ modifiedCount: 2 }));
      flightBookingModel.updateMany = jest.fn(() => query({ modifiedCount: 1 }));

      const result = await service.completeFinishedBookings(now);

      expect(result).toEqual({ hotels: 2, flights: 1 });
      expect(flightBookingModel.updateMany).toHaveBeenCalledWith(
        { status: FlightBookingStatus.CONFIRMED, departureTime: { $lte: now } },
        { $set: { status: FlightBookingStatus.COMPLETED, completedAt: now } },
      );
      expect(hotelBookingModel.updateMany).toHaveBeenCalledWith(
        {
          status: HotelBookingStatus.CONFIRMED,
          checkOutDate: { $lte: new Date('2030-06-09T12:00:00.000Z') },
        },
        { $set: { status: HotelBookingStatus.COMPLETED, completedAt: now } },
      );
    });
  });
});
