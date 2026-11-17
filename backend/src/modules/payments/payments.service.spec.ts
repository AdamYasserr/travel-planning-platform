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
import { isTestConfirmEnabled } from './test-mode';

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
  let configValues: Record<string, string>;
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
      { code: 'EGP' } as never,
      { get: (key: string) => configValues[key] } as never,
    );
  }

  const intentId = 'pi_test_1';

  function intentEvent(type: string, object: Record<string, any>, id = 'evt_pi') {
    return { id, type, data: { object: { id: intentId, object: 'payment_intent', ...object } } } as never;
  }

  const succeededIntent = (over: Record<string, any> = {}) =>
    intentEvent('payment_intent.succeeded', { amount: 20000, amount_received: 20000, currency: 'egp', metadata: { paymentId: paymentId.toString() }, ...over });

  beforeEach(() => {
    configValues = { 'stripe.secretKey': 'sk_test_x', 'app.environment': 'test' };
    payment = {
      _id: paymentId,
      userId,
      bookingType: PaymentBookingType.HOTEL,
      bookingId,
      amountMinor: 20000,
      currency: 'egp',
      status: PaymentStatus.PENDING,
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
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
      policiesAcceptedAt: new Date(),
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
      policiesAcceptedAt: new Date(),
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
      constructWebhookEvent: jest.fn(() => succeededIntent()),
      createPaymentIntent: jest.fn(async () => ({ id: intentId, status: 'requires_payment_method', client_secret: 'pi_test_1_secret_abc' })),
      retrievePaymentIntent: jest.fn(async () => ({ id: intentId, status: 'requires_payment_method', client_secret: 'pi_test_1_secret_abc' })),
      confirmPaymentIntent: jest.fn(async () => ({ id: intentId, status: 'succeeded' })),
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

  const pay = () =>
    service.createPayment(userId.toString(), { bookingType: PaymentBookingType.HOTEL, bookingId: bookingId.toString() });
  const hookWith = (event: unknown) => {
    stripeService.constructWebhookEvent = jest.fn(() => event as never);
    return service.handleStripeWebhook(Buffer.from('{}'), 'signed');
  };

  describe('create payment (PAY-01)', () => {
    it('creates a PaymentIntent with the amount and currency of the booking and returns the client secret', async () => {
      const response = await pay();

      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: 20000, currency: 'egp', bookingId: bookingId.toString(), userId: userId.toString() }),
      );
      expect(response).toMatchObject({ clientSecret: 'pi_test_1_secret_abc', amount: 200, amountMinor: 20000, currency: 'EGP' });
      expect(payment.stripePaymentIntentId).toBe(intentId);
    });

    it('never stores the client secret', async () => {
      await pay();
      expect(JSON.stringify(payment)).not.toContain('_secret_');
    });

    it('rejects payment attempts for another user’s booking', async () => {
      hotelBookingModel.findOne = jest.fn(() => query(null));
      await expect(
        service.createPayment(new Types.ObjectId().toString(), { bookingType: PaymentBookingType.HOTEL, bookingId: bookingId.toString() }),
      ).rejects.toThrow('Booking not found');
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('rejects a booking that is not pending payment (409)', async () => {
      hotelBooking.status = HotelBookingStatus.CONFIRMED;
      await expect(pay()).rejects.toThrow('Only bookings in Pending Payment can be paid');
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('rejects payment until the policies are accepted (PAY-02)', async () => {
      hotelBooking.policiesAcceptedAt = null;
      await expect(pay()).rejects.toThrow('You must accept the policies');
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('rejects an expired hold and releases it', async () => {
      hotelBooking.holdExpiresAt = new Date(Date.now() - 1000);
      await expect(pay()).rejects.toThrow('The booking hold has expired');
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('rejects a booking that is not in the platform currency (PAY-04)', async () => {
      hotelBooking.currency = 'USD';
      await expect(pay()).rejects.toThrow('platform currency EGP');
    });

    it('reuses the open PaymentIntent instead of creating a second one', async () => {
      payment.stripePaymentIntentId = intentId;
      const response = await pay();
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
      expect(response.clientSecret).toBe('pi_test_1_secret_abc');
    });

    it('tells the user to retry when the last attempt failed', async () => {
      payment.status = PaymentStatus.FAILED;
      payment.stripePaymentIntentId = intentId;
      // An existing payment: the upsert's $setOnInsert changes nothing.
      paymentModel.findOneAndUpdate = jest.fn(() => query(payment));
      await expect(pay()).rejects.toThrow('/retry');
    });
  });

  describe('retry (PAY-01)', () => {
    beforeEach(() => {
      payment.status = PaymentStatus.FAILED;
      payment.stripePaymentIntentId = intentId;
      payment.lastFailureCode = 'card_declined';
    });
    const retry = () => service.retryPayment(userId.toString(), paymentId.toString());

    it('reuses the same PaymentIntent while Stripe says it is still usable', async () => {
      const response = await retry();
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
      expect(response.clientSecret).toBe('pi_test_1_secret_abc');
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });

    it('creates a new PaymentIntent when the old one was cancelled (key derived from the old id)', async () => {
      stripeService.retrievePaymentIntent = jest.fn(async () => ({ id: intentId, status: 'canceled' }));
      stripeService.createPaymentIntent = jest.fn(async () => ({ id: 'pi_new', status: 'requires_payment_method', client_secret: 'pi_new_secret_x' }));
      const response = await retry();
      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: `pi-${paymentId.toString()}-after-${intentId}` }),
      );
      expect(payment.stripePaymentIntentId).toBe('pi_new');
      expect(response.clientSecret).toBe('pi_new_secret_x');
    });

    it('refuses when the PaymentIntent is already processing or succeeded', async () => {
      stripeService.retrievePaymentIntent = jest.fn(async () => ({ id: intentId, status: 'processing' }));
      await expect(retry()).rejects.toThrow('cannot be retried');
    });

    it('refuses when the last attempt did not fail', async () => {
      payment.status = PaymentStatus.PENDING;
      await expect(retry()).rejects.toThrow('last attempt failed');
    });

    it('refuses once the hold expired', async () => {
      hotelBooking.holdExpiresAt = new Date(Date.now() - 1000);
      await expect(retry()).rejects.toThrow('The booking hold has expired');
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('is 404 for another user’s payment', async () => {
      paymentModel.findOne = jest.fn(() => query(null));
      await expect(service.retryPayment(new Types.ObjectId().toString(), paymentId.toString())).rejects.toThrow('Payment not found');
    });
  });

  describe('test-confirm', () => {
    beforeEach(() => {
      payment.stripePaymentIntentId = intentId;
    });
    const confirm = (outcome?: 'success' | 'decline') => service.testConfirm(userId.toString(), paymentId.toString(), outcome);

    it('isTestConfirmEnabled: only an sk_test_ key outside production', () => {
      expect(isTestConfirmEnabled('sk_test_abc', 'development')).toBe(true);
      expect(isTestConfirmEnabled('sk_test_abc', 'test')).toBe(true);
      expect(isTestConfirmEnabled('sk_test_abc', 'production')).toBe(false);
      expect(isTestConfirmEnabled('sk_live_abc', 'development')).toBe(false);
      expect(isTestConfirmEnabled('', 'development')).toBe(false);
      expect(isTestConfirmEnabled(undefined, undefined)).toBe(false);
    });

    it('is 404 with a live key, and calls nothing', async () => {
      configValues['stripe.secretKey'] = 'sk_live_abc';
      await expect(confirm()).rejects.toThrow('Not Found');
      expect(stripeService.confirmPaymentIntent).not.toHaveBeenCalled();
    });

    it('is 404 in production', async () => {
      configValues['app.environment'] = 'production';
      await expect(confirm()).rejects.toThrow('Not Found');
      expect(stripeService.confirmPaymentIntent).not.toHaveBeenCalled();
    });

    it('pays with pm_card_visa by default and never touches the booking or the payment status', async () => {
      const result = await confirm();
      expect(stripeService.confirmPaymentIntent).toHaveBeenCalledWith(intentId, 'pm_card_visa');
      expect(result).toMatchObject({ outcome: 'succeeded' });
      expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });

    it('decline uses pm_card_chargeDeclined and reports a normal "declined" outcome', async () => {
      stripeService.confirmPaymentIntent = jest.fn(async () => {
        throw Object.assign(new Error('declined'), { type: 'StripeCardError', code: 'card_declined' });
      });
      const result = await confirm('decline');
      expect(stripeService.confirmPaymentIntent).toHaveBeenCalledWith(intentId, 'pm_card_chargeDeclined');
      expect(result).toMatchObject({ outcome: 'declined', code: 'card_declined' });
    });

    it('is 404 for another user’s payment and 409 for a booking that is not pending', async () => {
      hotelBooking.status = HotelBookingStatus.CONFIRMED;
      await expect(confirm()).rejects.toThrow('Only bookings in Pending Payment can be paid');
      paymentModel.findOne = jest.fn(() => query(null));
      await expect(confirm()).rejects.toThrow('Payment not found');
    });
  });

  describe('webhook', () => {
    it('rejects webhook requests with an invalid signature', async () => {
      stripeService.constructWebhookEvent = jest.fn(() => {
        throw new Error('signature mismatch');
      });
      await expect(service.handleStripeWebhook(Buffer.from('{}'), 'invalid')).rejects.toThrow('Invalid Stripe webhook signature');
    });

    it('confirms only when the PaymentIntent, amount and currency all match the booking', async () => {
      payment.stripePaymentIntentId = intentId;
      await hookWith(succeededIntent());

      expect(hotelBookingModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: HotelBookingStatus.PENDING_PAYMENT,
          holdExpiresAt: expect.objectContaining({ $gt: expect.any(Date) }),
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: HotelBookingStatus.CONFIRMED, holdExpiresAt: null }),
        }),
        expect.objectContaining({ new: true }),
      );
      expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    });

    it('does not confirm a success for a different PaymentIntent id', async () => {
      payment.stripePaymentIntentId = 'pi_other';
      await hookWith(succeededIntent());
      expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(stripeService.createRefund).not.toHaveBeenCalled();
    });

    it.each([
      ['amount', { amount: 100, amount_received: 100 }],
      ['currency', { currency: 'usd' }],
    ])('does not confirm when the %s differs from the booking; flags it for refund', async (_name, over) => {
      payment.stripePaymentIntentId = intentId;
      await hookWith(succeededIntent(over));
      expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $set: expect.objectContaining({ status: HotelBookingStatus.CONFIRMED }) }),
        expect.anything(),
      );
      expect(payment.status).not.toBe(PaymentStatus.SUCCEEDED);
      // The existing refund path returns the money straight away (it clears the failure code once refunded).
      expect(stripeService.createRefund).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: intentId }));
      expect(payment.refundPercentage).toBe(100);
    });

    it('records payment failures without confirming the booking', async () => {
      payment.stripePaymentIntentId = intentId;
      await hookWith(intentEvent('payment_intent.payment_failed', { last_payment_error: { code: 'card_declined' } }));
      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.lastFailureCode).toBe('card_declined');
      expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('ignores a failure event for a PaymentIntent that is not ours', async () => {
      payment.stripePaymentIntentId = 'pi_other';
      await hookWith(intentEvent('payment_intent.payment_failed', { metadata: { paymentId: paymentId.toString() } }));
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });

    it('ignores duplicate successful webhook delivery after its first processing', async () => {
      payment.status = PaymentStatus.SUCCEEDED;
      webhookEventModel.findOne = jest.fn(() => query({ paymentId, status: 'Processed' }));
      await hookWith(succeededIntent());
      expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(stripeService.createRefund).not.toHaveBeenCalled();
    });

    it('does not confirm a success that arrives after the hold expired; the money is flagged for refund', async () => {
      payment.stripePaymentIntentId = intentId;
      hotelBooking.status = HotelBookingStatus.EXPIRED;
      hotelBooking.holdExpiresAt = new Date(Date.now() - 1000);
      await hookWith(succeededIntent());

      expect(hotelBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(stripeService.createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: intentId, amountMinor: 20000 }),
      );
      expect(payment.status).toBe(PaymentStatus.REFUNDED);
    });

    it('expires the flight hold and restores seats before refunding a late payment', async () => {
      payment.bookingType = PaymentBookingType.FLIGHT;
      payment.stripePaymentIntentId = intentId;
      flightBooking.status = FlightBookingStatus.PENDING_PAYMENT;
      flightBooking.holdExpiresAt = new Date(Date.now() - 1000);
      flightBookingModel.findOneAndUpdate = jest.fn(() => query({ ...flightBooking, status: FlightBookingStatus.EXPIRED }));

      await hookWith(succeededIntent());

      expect(inventoryModel.updateOne).toHaveBeenCalledWith(
        { _id: flightBooking.cabinInventoryId },
        { $inc: { availableSeats: 2 } },
        expect.objectContaining({ session: expect.anything() }),
      );
      expect(stripeService.createRefund).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: intentId }));
      expect(flightBookingModel.findOneAndUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: FlightBookingStatus.PENDING_PAYMENT }),
        expect.objectContaining({ $set: expect.objectContaining({ status: FlightBookingStatus.CONFIRMED }) }),
        expect.anything(),
      );
    });
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
    expect(result.refundId).toBe(paymentId.toString()); // use with GET /refunds/:id
    expect(stripeService.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 10000 }),
    );
    expect(payment.refundAmountMinor).toBe(10000);
    expect(payment.refundStatus).toBe(RefundStatus.SUCCEEDED);
    expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
  });

  it('rejects cancelling an already-cancelled booking (409) and issues no second refund', async () => {
    hotelBooking.status = HotelBookingStatus.CANCELLED;
    payment.status = PaymentStatus.REFUNDED;
    payment.refundStatus = RefundStatus.SUCCEEDED;

    await expect(
      service.cancelBooking(
        userId.toString(),
        PaymentBookingType.HOTEL,
        bookingId.toString(),
      ),
    ).rejects.toThrow(/already cancelled/i);

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

  it('releases an unpaid hold as Expired (not Cancelled) and cancels the PaymentIntent', async () => {
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

  describe('refund id (GET /refunds/:id uses the payment id)', () => {
    it('GET /payments/:id returns refundId equal to the payment id once a refund exists', async () => {
      payment.refundStatus = RefundStatus.PENDING;
      payment.refundAmountMinor = 10000;
      const result: any = await service.getForUser(userId.toString(), paymentId.toString());
      expect(result.refundId).toBe(paymentId.toString());
    });

    it('refundId is null when no refund applies', async () => {
      const result: any = await service.getForUser(userId.toString(), paymentId.toString());
      expect(result.refundId).toBeNull();
    });

    it('an unpaid hold cancellation (Expired, nothing to refund) returns refundId null', async () => {
      payment.status = PaymentStatus.PENDING;
      hotelBookingModel.findOneAndUpdate = jest.fn(() =>
        query({ ...hotelBooking, status: HotelBookingStatus.EXPIRED }),
      );
      const result = await service.cancelBooking(userId.toString(), PaymentBookingType.HOTEL, bookingId.toString());
      expect(result.refundId).toBeNull();
    });

    it('getRefundForUser returns the refund view keyed by that id', async () => {
      payment.refundStatus = RefundStatus.SUCCEEDED;
      payment.refundPercentage = 50;
      payment.refundAmountMinor = 10000;
      payment.refundedAt = new Date('2030-01-01');
      const refund = await service.getRefundForUser(userId.toString(), paymentId.toString());
      expect(refund).toEqual({
        refundId: paymentId.toString(),
        paymentId: paymentId.toString(),
        bookingType: PaymentBookingType.HOTEL,
        bookingId,
        status: RefundStatus.SUCCEEDED,
        percentage: 50,
        amountMinor: 10000,
        currency: 'egp',
        requestedAt: null,
        refundedAt: new Date('2030-01-01'),
      });
    });

    it('getRefundForUser is 404 when the payment has no refund or is not yours', async () => {
      await expect(service.getRefundForUser(userId.toString(), paymentId.toString())).rejects.toThrow('No refund exists for this payment');
      paymentModel.findOne = jest.fn(() => query(null));
      await expect(service.getRefundForUser(new Types.ObjectId().toString(), paymentId.toString())).rejects.toThrow('Payment not found');
    });
  });
});
