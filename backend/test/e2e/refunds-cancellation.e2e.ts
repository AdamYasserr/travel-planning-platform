import { PaymentsService } from '../../src/modules/payments/payments.service';
import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdFlight, holdHotel, intentIdOf, sendWebhook, startPayment } from './helpers/bookings';
import { createAirlineWithFlight, createHotelWithRooms, createUser, day, type TestUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

/** Refunds (PAY-03), flight cancellation (FLT-06), notifications (GEN-01) and the e-ticket (FLT-23). */
describe('refunds, cancellation, notifications and e-tickets (PAY-03, FLT-06, GEN-01, FLT-23)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  const model = (name: string) => ctx.conn.model(name);
  const payments = () => ctx.get(PaymentsService);

  /**
   * A Confirmed hotel booking (3 nights x 1500 = 4500 EGP, paid 450000 minor). Default tiers on the hotel:
   * 100% from 7 days before check-in, 0% after. `tiers` replaces them before the booking is made.
   */
  async function paidHotel(opts: { checkIn?: number; tiers?: { daysBeforeCheckIn: number; refundPercentage: number }[]; user?: TestUser } = {}) {
    const { hotelId, roomIds, moderator } = await createHotelWithRooms(ctx, { rooms: 1 });
    if (opts.tiers) {
      const res = await moderator.agent.put(`/api/hotels/${hotelId}/policies`).send({ checkInTime: '15:00', checkOutTime: '11:00', cancellationTiers: opts.tiers });
      if (res.status !== 200) throw new Error(`policies failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const user = opts.user ?? (await createUser(ctx));
    const checkIn = opts.checkIn ?? 20;
    const hold = await holdHotel(user, { hotelId, roomIds, checkIn: day(checkIn), checkOut: day(checkIn + 3) });
    if (hold.status !== 201) throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.body)}`);
    const bookingId = String(hold.body._id);
    const paymentId = await confirmBooking(ctx, user, 'hotel', bookingId);
    return { user, bookingId, paymentId, hotelId };
  }

  const cancelHotel = (user: TestUser, bookingId: string) => user.agent.post(`/api/hotel-bookings/${bookingId}/cancel`);
  const refundOf = (user: TestUser, refundId: string) => user.agent.get(`/api/refunds/${refundId}`);
  const stripeCallsFor = (paymentId: string) => ctx.stripe.refunds.filter((r) => r.paymentId === paymentId).length;

  describe('refunds (PAY-03)', () => {
    it('cancelling a Confirmed booking creates exactly one refund on the original PaymentIntent, for the tier share', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      const intentId = (await model('Payment').findById(paymentId).lean() as any).stripePaymentIntentId;

      const cancel = await cancelHotel(user, bookingId);
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ refundPercentage: 100, refundStatus: 'Refunded' });
      expect(cancel.body.booking.status).toBe('Cancelled');

      expect(await model('Refund').countDocuments({ paymentId })).toBe(1);
      expect(ctx.stripe.refunds.filter((r) => r.paymentId === paymentId)).toEqual([{ paymentIntentId: intentId, amountMinor: 450000, paymentId }]);
      const refund = await refundOf(user, cancel.body.refundId);
      expect(refund.status).toBe(200);
      expect(refund.body).toMatchObject({ status: 'Refunded', amountMinor: 450000, currency: 'egp', percentage: 100, reason: 'booking_cancelled', paymentId, bookingId, bookingType: 'hotel' });
      expect((await user.agent.get(`/api/payments/${paymentId}`)).body.status).toBe('Refunded');
    });

    it('a partial tier refunds that share of what was paid (Partially Refunded)', async () => {
      const { user, bookingId, paymentId } = await paidHotel({ tiers: [{ daysBeforeCheckIn: 7, refundPercentage: 50 }, { daysBeforeCheckIn: 0, refundPercentage: 0 }] });
      const cancel = await cancelHotel(user, bookingId);
      expect(cancel.body.refundPercentage).toBe(50);
      expect((await refundOf(user, cancel.body.refundId)).body).toMatchObject({ amountMinor: 225000, status: 'Refunded' });
      expect((await user.agent.get(`/api/payments/${paymentId}`)).body.status).toBe('Partially Refunded');
    });

    it('a 0% tier cancels the booking but creates no refund and calls Stripe for nothing', async () => {
      const { user, bookingId, paymentId } = await paidHotel({ checkIn: 3 });
      const cancel = await cancelHotel(user, bookingId);
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ refundPercentage: 0, refundId: null });
      expect(cancel.body.booking.status).toBe('Cancelled');
      expect(await model('Refund').countDocuments({ paymentId })).toBe(0);
      expect(stripeCallsFor(paymentId)).toBe(0);
    });

    it('cancelling twice is 409 and never creates a second refund', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      expect((await cancelHotel(user, bookingId)).status).toBe(200);
      expect((await cancelHotel(user, bookingId)).status).toBe(409);
      expect(await model('Refund').countDocuments({ paymentId })).toBe(1);
      expect(stripeCallsFor(paymentId)).toBe(1);
    });

    it('when Stripe is unreachable the refund stays Pending; two job runs at once send it exactly once', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      ctx.stripe.nextRefundOutcomes.push('error');
      const cancel = await cancelHotel(user, bookingId);
      expect(cancel.status).toBe(200);
      expect(cancel.body.refundStatus).toBe('Pending');
      expect(stripeCallsFor(paymentId)).toBe(1);

      await Promise.all([payments().retryPendingRefunds(), payments().retryPendingRefunds()]);
      expect(stripeCallsFor(paymentId)).toBe(2);
      expect((await refundOf(user, cancel.body.refundId)).body.status).toBe('Refunded');

      await payments().retryPendingRefunds();
      expect(stripeCallsFor(paymentId)).toBe(2);
      expect(await model('Refund').countDocuments({ paymentId })).toBe(1);
    });

    it('a refund Stripe accepted as pending becomes Refunded by the signed webhook; a duplicate event changes nothing', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      ctx.stripe.nextRefundOutcomes.push('pending');
      const cancel = await cancelHotel(user, bookingId);
      expect(cancel.body.refundStatus).toBe('Pending');
      expect((await user.agent.get(`/api/payments/${paymentId}`)).body.status).toBe('Refund Pending');

      // The job does not ask Stripe again for a refund Stripe already has.
      await payments().retryPendingRefunds();
      expect(stripeCallsFor(paymentId)).toBe(1);

      const event = ctx.stripe.refundEvent(ctx.stripe.stripeRefundFor(paymentId)!.id, 'succeeded');
      expect((await sendWebhook(ctx, event)).status).toBe(201);
      const refunded = (await refundOf(user, cancel.body.refundId)).body;
      expect(refunded.status).toBe('Refunded');
      expect((await user.agent.get(`/api/payments/${paymentId}`)).body.status).toBe('Refunded');

      expect((await sendWebhook(ctx, event)).status).toBe(201);
      expect((await refundOf(user, cancel.body.refundId)).body.refundedAt).toBe(refunded.refundedAt);
      expect(await model('StripeWebhookEvent').countDocuments({ stripeEventId: event.id })).toBe(1);
    });

    it('refund.failed marks it Failed (final): no retry, and a later success event does not change it', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      ctx.stripe.nextRefundOutcomes.push('pending');
      const cancel = await cancelHotel(user, bookingId);
      const stripeRefundId = ctx.stripe.stripeRefundFor(paymentId)!.id;

      await sendWebhook(ctx, ctx.stripe.refundEvent(stripeRefundId, 'failed'));
      expect((await refundOf(user, cancel.body.refundId)).body).toMatchObject({ status: 'Failed', failureCode: 'expired_or_canceled_card' });
      expect((await user.agent.get(`/api/payments/${paymentId}`)).body.status).toBe('Refund Failed');

      await payments().retryPendingRefunds();
      expect(stripeCallsFor(paymentId)).toBe(1);
      await sendWebhook(ctx, ctx.stripe.refundEvent(stripeRefundId, 'succeeded'));
      expect((await refundOf(user, cancel.body.refundId)).body.status).toBe('Failed');
    });

    it('a refund Stripe rejects at once is Failed and never retried', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      ctx.stripe.nextRefundOutcomes.push('failed');
      const cancel = await cancelHotel(user, bookingId);
      expect(cancel.body.refundStatus).toBe('Failed');
      await payments().retryPendingRefunds();
      expect(stripeCallsFor(paymentId)).toBe(1);
    });

    it('charge.refunded also completes a pending refund', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      ctx.stripe.nextRefundOutcomes.push('pending');
      const cancel = await cancelHotel(user, bookingId);
      const payment = await model('Payment').findById(paymentId).lean() as any;
      await sendWebhook(ctx, ctx.stripe.chargeRefundedEvent(payment.stripePaymentIntentId, 450000, ctx.stripe.stripeRefundFor(paymentId)!.id));
      expect((await refundOf(user, cancel.body.refundId)).body.status).toBe('Refunded');
    });

    it('a refund event with a bad signature is 400 and changes nothing', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      ctx.stripe.nextRefundOutcomes.push('pending');
      const cancel = await cancelHotel(user, bookingId);
      const res = await sendWebhook(ctx, ctx.stripe.refundEvent(ctx.stripe.stripeRefundFor(paymentId)!.id, 'succeeded'), 'forged');
      expect(res.status).toBe(400);
      expect((await refundOf(user, cancel.body.refundId)).body.status).toBe('Pending');
    });

    it('GET /refunds/:id: owner and admin only (others 404), 401 signed out, 400 for a bad id', async () => {
      const { user, bookingId } = await paidHotel();
      const { refundId } = (await cancelHotel(user, bookingId)).body;
      expect((await refundOf(user, refundId)).status).toBe(200);
      expect((await refundOf(await createUser(ctx, 'admin'), refundId)).status).toBe(200);
      expect((await refundOf(await createUser(ctx), refundId)).status).toBe(404);
      expect((await refundOf(await createUser(ctx, 'moderator'), refundId)).status).toBe(404);
      expect((await ctx.http().get(`/api/refunds/${refundId}`)).status).toBe(401);
      expect((await user.agent.get('/api/refunds/not-an-id')).status).toBe(400);
    });

    it('a payment that succeeds after the hold expired gets a 100% refund record, processed the same way', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const hold = await holdHotel(user, { hotelId, roomIds });
      const pay = await startPayment(user, 'hotel', hold.body._id);
      await model('HotelBooking').updateOne({ _id: hold.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      await payments().expirePendingBookings();

      await sendWebhook(ctx, ctx.stripe.succeededEvent(intentIdOf(ctx, pay.body)));
      const payment = (await user.agent.get(`/api/payments/${pay.body.paymentId}`)).body;
      expect(payment.status).toBe('Refunded');
      expect(payment.refundId).toEqual(expect.any(String));
      expect((await refundOf(user, payment.refundId)).body).toMatchObject({ status: 'Refunded', percentage: 100, amountMinor: 450000, reason: 'late_payment' });
      expect((await user.agent.get(`/api/hotel-bookings/${hold.body._id}`)).body.status).toBe('Expired');
      expect(stripeCallsFor(String(pay.body.paymentId))).toBe(1);
    });

    it('a Confirmed flight booking is refunded with the airline tier snapshotted on the booking', async () => {
      const { airlineId, flightId, moderator } = await createAirlineWithFlight(ctx, { seats: 4, price: 5000 });
      await moderator.agent.put(`/api/airlines/${airlineId}/cancellation-policy`).send({ tiers: [{ daysBeforeDeparture: 7, refundPercentage: 80 }, { daysBeforeDeparture: 0, refundPercentage: 0 }] });
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      const paymentId = await confirmBooking(ctx, user, 'flight', hold.body._id);
      const cancel = await user.agent.post(`/api/flight-bookings/${hold.body._id}/cancel`);
      expect(cancel.status).toBe(200);
      expect(cancel.body.refundPercentage).toBe(80);
      expect((await refundOf(user, cancel.body.refundId)).body).toMatchObject({ amountMinor: 400000, status: 'Refunded', bookingType: 'flight' });
      expect(stripeCallsFor(paymentId)).toBe(1);
    });
  });
});
