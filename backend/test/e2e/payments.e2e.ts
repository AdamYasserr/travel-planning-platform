import { PaymentsService } from '../../src/modules/payments/payments.service';
import { startApp, type E2EContext } from './helpers/app';
import { acceptPolicies, confirmBooking, holdFlight, holdHotel, intentIdOf, sendWebhook, startPayment, type BookingType } from './helpers/bookings';
import { createAirlineWithFlight, createHotelWithRooms, createUser, day, idOf, type TestUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

/** Payments with Stripe PaymentIntents (PAY-01), policy acceptance (PAY-02) and the platform currency (PAY-04). */
describe('payments, policies and platform currency (PAY-01, PAY-02, PAY-04)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  /** A user with a fresh hotel hold (3 nights x 1500 EGP = 4500). */
  async function hotelHold(opts: { accepted?: boolean; user?: TestUser } = {}) {
    const { hotelId, roomIds, moderator } = await createHotelWithRooms(ctx, { rooms: 1 });
    const user = opts.user ?? (await createUser(ctx));
    const hold = await holdHotel(user, { hotelId, roomIds, body: { policiesAccepted: opts.accepted ?? true } });
    if (hold.status !== 201) throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.body)}`);
    return { user, bookingId: String(hold.body._id), hotelId, roomIds, moderator, hold };
  }

  /** A hold with an open payment (policies accepted). */
  async function openPayment(opts: { user?: TestUser } = {}) {
    const held = await hotelHold(opts);
    const pay = await startPayment(held.user, 'hotel', held.bookingId);
    if (pay.status !== 201) throw new Error(`payment failed: ${pay.status} ${JSON.stringify(pay.body)}`);
    return { ...held, pay, paymentId: String(pay.body.paymentId), intentId: intentIdOf(ctx, pay.body) };
  }

  const bookingStatus = async (user: TestUser, type: BookingType, id: string) => (await user.agent.get(`/api/${type}-bookings/${id}`)).body.status as string;
  const paymentOf = async (user: TestUser, paymentId: string) => (await user.agent.get(`/api/payments/${paymentId}`)).body;
  const model = (name: 'HotelBooking' | 'FlightBooking' | 'Payment') => ctx.conn.model(name);
  const lapseHold = (name: 'HotelBooking' | 'FlightBooking', bookingId: string) =>
    model(name).updateOne({ _id: bookingId }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });

  describe('policies (PAY-02)', () => {
    it('GET returns the hotel cancellation tiers and check-in/check-out times', async () => {
      const { user, bookingId } = await hotelHold();
      const res = await user.agent.get(`/api/bookings/hotel/${bookingId}/policies`);
      expect(res.status).toBe(200);
      expect(res.body.policies.checkInTime).toBe('15:00');
      expect(res.body.policies.checkOutTime).toBe('11:00');
      expect(res.body.policies.cancellation.tiers).toEqual([
        { daysBeforeCheckIn: 7, refundPercentage: 100 },
        { daysBeforeCheckIn: 0, refundPercentage: 0 },
      ]);
    });

    it('GET returns the flight cancellation and baggage policies, snapshotted at booking time', async () => {
      const { airlineId, flightId, moderator } = await createAirlineWithFlight(ctx, { seats: 4 });
      expect((await moderator.agent.put(`/api/airlines/${airlineId}/baggage-policy`).send({
        carryOnAllowanceKg: 7, checkedBaggageAllowanceKg: 23, pricePerExtraBag: 40, maxExtraBagsPerPassenger: 2, currency: 'EGP',
      })).status).toBe(200);
      expect((await moderator.agent.put(`/api/airlines/${airlineId}/cancellation-policy`).send({
        tiers: [{ daysBeforeDeparture: 14, refundPercentage: 80 }, { daysBeforeDeparture: 0, refundPercentage: 0 }],
      })).status).toBe(200);
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId, body: { policiesAccepted: false } });
      expect(hold.status).toBe(201);

      const res = await user.agent.get(`/api/bookings/flight/${hold.body._id}/policies`);
      expect(res.status).toBe(200);
      expect(res.body.policies.cancellation.tiers).toEqual([
        { daysBeforeDeparture: 14, refundPercentage: 80 },
        { daysBeforeDeparture: 0, refundPercentage: 0 },
      ]);
      expect(res.body.policies.baggage).toMatchObject({ carryOnAllowanceKg: 7, checkedBaggageAllowanceKg: 23, pricePerExtraBag: 40, maxExtraBagsPerPassenger: 2, freeBagsCount: 1, maxWeightPerBagKg: 23 });

      // What the user is shown cannot change afterwards.
      await moderator.agent.put(`/api/airlines/${airlineId}/baggage-policy`).send({
        carryOnAllowanceKg: 1, checkedBaggageAllowanceKg: 1, pricePerExtraBag: 999, maxExtraBagsPerPassenger: 0, currency: 'EGP',
      });
      const again = await user.agent.get(`/api/bookings/flight/${hold.body._id}/policies`);
      expect(again.body.policies.baggage.pricePerExtraBag).toBe(40);
    });

    it.each(['hotel', 'flight'] as const)('payment is blocked (409) until the %s policies are accepted, then allowed', async (type) => {
      let user: TestUser, bookingId: string;
      if (type === 'hotel') {
        ({ user, bookingId } = await hotelHold({ accepted: false }));
      } else {
        const { flightId } = await createAirlineWithFlight(ctx, { seats: 4 });
        user = await createUser(ctx);
        bookingId = String((await holdFlight(user, { flightId, body: { policiesAccepted: false } })).body._id);
      }
      const blocked = await startPayment(user, type, bookingId);
      expect(blocked.status).toBe(409);
      expect(blocked.body.message).toMatch(/accept the policies/i);
      expect(ctx.stripe.created.filter((c) => c.bookingId === bookingId)).toHaveLength(0);

      expect((await acceptPolicies(user, type, bookingId)).status).toBe(200);
      expect((await startPayment(user, type, bookingId)).status).toBe(201);
    });

    it('acceptance is stored with a timestamp and a second call keeps the first one', async () => {
      const { user, bookingId } = await hotelHold({ accepted: false });
      const before = await user.agent.get(`/api/bookings/hotel/${bookingId}/policies`);
      expect(before.body.accepted).toBe(false);
      expect(before.body.policiesAcceptedAt).toBeNull();

      const first = await acceptPolicies(user, 'hotel', bookingId);
      expect(first.status).toBe(200);
      expect(first.body.accepted).toBe(true);
      expect(Math.abs(Date.now() - new Date(first.body.policiesAcceptedAt).getTime())).toBeLessThan(30_000);
      const stored = await model('HotelBooking').findById(bookingId).lean();
      expect((stored as any).policiesAcceptedAt).toEqual(new Date(first.body.policiesAcceptedAt));

      const second = await acceptPolicies(user, 'hotel', bookingId);
      expect(second.status).toBe(200);
      expect(second.body.policiesAcceptedAt).toBe(first.body.policiesAcceptedAt);
    });

    it('accepting at booking time (policiesAccepted: true) is recorded with a timestamp', async () => {
      const { user, bookingId, hold } = await hotelHold({ accepted: true });
      expect(hold.body.policiesAcceptedAt).toBeTruthy();
      const res = await user.agent.get(`/api/bookings/hotel/${bookingId}/policies`);
      expect(res.body.accepted).toBe(true);
    });

    it.each([[{}], [{ accepted: false }], [{ accepted: 'true' }], [{ accepted: 1 }], [{ accepted: true, extra: 1 }]])('accept-policies body %j is 400', async (body) => {
      const { user, bookingId } = await hotelHold({ accepted: false });
      const res = await user.agent.post(`/api/bookings/hotel/${bookingId}/accept-policies`).send(body);
      expect(res.status).toBe(400);
      expect((await user.agent.get(`/api/bookings/hotel/${bookingId}/policies`)).body.accepted).toBe(false);
    });

    it("another user's booking is 404 for policies, acceptance and payment", async () => {
      const { bookingId } = await hotelHold({ accepted: false });
      const other = await createUser(ctx);
      expect((await other.agent.get(`/api/bookings/hotel/${bookingId}/policies`)).status).toBe(404);
      expect((await acceptPolicies(other, 'hotel', bookingId)).status).toBe(404);
      expect((await startPayment(other, 'hotel', bookingId)).status).toBe(404);
    });

    it('needs a signed-in user, a known type and a valid id', async () => {
      const { user, bookingId } = await hotelHold();
      expect((await ctx.http().get(`/api/bookings/hotel/${bookingId}/policies`)).status).toBe(401);
      expect((await ctx.http().post(`/api/bookings/hotel/${bookingId}/accept-policies`).send({ accepted: true })).status).toBe(401);
      expect((await user.agent.get(`/api/bookings/car/${bookingId}/policies`)).status).toBe(400);
      expect((await user.agent.get('/api/bookings/hotel/not-an-id/policies')).status).toBe(400);
    });

    it('policies can no longer be accepted once the hold expired or the booking is confirmed (409)', async () => {
      const lapsed = await hotelHold({ accepted: false });
      await lapseHold('HotelBooking', lapsed.bookingId);
      expect((await acceptPolicies(lapsed.user, 'hotel', lapsed.bookingId)).status).toBe(409);

      const paid = await hotelHold();
      await confirmBooking(ctx, paid.user, 'hotel', paid.bookingId);
      expect((await acceptPolicies(paid.user, 'hotel', paid.bookingId)).status).toBe(409);
    });
  });

  describe('create a payment (PAY-01)', () => {
    it('returns paymentId, clientSecret, amount and currency, taken from the booking', async () => {
      const { pay, bookingId, paymentId } = await openPayment();
      expect(pay.body).toMatchObject({ paymentId, amount: 4500, amountMinor: 450000, currency: 'EGP' });
      expect(pay.body.clientSecret).toMatch(/^pi_.+_secret_.+/);
      const sent = ctx.stripe.created.find((c) => c.bookingId === bookingId)!;
      expect(sent).toMatchObject({ amountMinor: 450000, currency: 'egp' });
    });

    it('the amount of a flight comes from the seats booked', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 4, price: 5000 });
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId, passengers: 2 });
      const pay = await startPayment(user, 'flight', hold.body._id);
      expect(pay.status).toBe(201);
      expect(pay.body).toMatchObject({ amount: 10000, amountMinor: 1000000, currency: 'EGP' });
    });

    it('the client cannot choose the amount or currency (extra fields are 400)', async () => {
      const { user, bookingId } = await hotelHold();
      const res = await user.agent.post('/api/payments').send({ bookingType: 'hotel', bookingId, amount: 1, currency: 'USD' });
      expect(res.status).toBe(400);
    });

    it.each([['car'], ['Hotel'], ['HOTEL'], [''], [undefined]])('bookingType %p is 400 (exactly "flight" or "hotel")', async (bookingType) => {
      const { user, bookingId } = await hotelHold();
      const res = await user.agent.post('/api/payments').send({ bookingType, bookingId });
      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]?.field).toBe('bookingType');
    });

    it('a bad bookingId is 400 and an unknown one is 404', async () => {
      const user = await createUser(ctx);
      expect((await user.agent.post('/api/payments').send({ bookingType: 'hotel', bookingId: 'nope' })).status).toBe(400);
      expect((await user.agent.post('/api/payments').send({ bookingType: 'hotel', bookingId: '507f1f77bcf86cd799439011' })).status).toBe(404);
    });

    it('needs a signed-in user', async () => {
      expect((await ctx.http().post('/api/payments').send({ bookingType: 'hotel', bookingId: '507f1f77bcf86cd799439011' })).status).toBe(401);
    });

    it('does not confirm the booking: creating a payment leaves it Pending Payment', async () => {
      const { user, bookingId } = await openPayment();
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Pending Payment');
    });

    it('is rejected (409) when the hold already expired, and the hold is released', async () => {
      const { user, bookingId } = await hotelHold();
      await lapseHold('HotelBooking', bookingId);
      const res = await startPayment(user, 'hotel', bookingId);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/hold has expired/i);
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Expired');
    });

    it('is rejected (409) for a booking that is not Pending Payment', async () => {
      const { user, bookingId } = await hotelHold();
      await confirmBooking(ctx, user, 'hotel', bookingId);
      expect((await startPayment(user, 'hotel', bookingId)).status).toBe(409);
    });

    it('asking again returns the same open PaymentIntent, not a second payment', async () => {
      const { user, bookingId, pay } = await openPayment();
      const again = await startPayment(user, 'hotel', bookingId);
      expect(again.status).toBe(201);
      expect(again.body.paymentId).toBe(pay.body.paymentId);
      expect(again.body.clientSecret).toBe(pay.body.clientSecret);
      expect(await model('Payment').countDocuments({ bookingId })).toBe(1);
    });

    it('GET /payments/:id is owner-only and shows the status without any Stripe secret', async () => {
      const { user, paymentId } = await openPayment();
      const res = await user.agent.get(`/api/payments/${paymentId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'Pending', amountMinor: 450000, currency: 'egp' });
      expect(JSON.stringify(res.body)).not.toContain('_secret_');
      expect((await (await createUser(ctx)).agent.get(`/api/payments/${paymentId}`)).status).toBe(404);
      expect((await ctx.http().get(`/api/payments/${paymentId}`)).status).toBe(401);
    });

    it('stores only the PaymentIntent id, amount, currency and status: no client secret, no card data', async () => {
      const { paymentId, pay, intentId } = await openPayment();
      const stored = await model('Payment').findById(paymentId).lean();
      const json = JSON.stringify(stored);
      expect(json).not.toContain(pay.body.clientSecret);
      expect(json).not.toContain('_secret_');
      expect(json).not.toMatch(/card|client_secret|clientSecret/i);
      expect(stored).toMatchObject({ stripePaymentIntentId: intentId, amountMinor: 450000, currency: 'egp', status: 'Pending' });
      expect(stored).not.toHaveProperty('stripeCheckoutSessionId');
      expect(stored).not.toHaveProperty('stripeCheckoutUrl');
    });

    it('the old Checkout Session route is gone', async () => {
      const { user, bookingId } = await hotelHold();
      expect((await user.agent.post('/api/payments/checkout-session').send({ bookingType: 'hotel', bookingId })).status).toBe(404);
    });
  });

  describe('the signed webhook confirms the booking (PAY-01)', () => {
    it('payment_intent.succeeded confirms a hotel booking and marks the payment Succeeded', async () => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      const hook = await sendWebhook(ctx, ctx.stripe.succeededEvent(intentId));
      expect(hook.status).toBe(201);
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Confirmed');
      expect((await paymentOf(user, paymentId)).status).toBe('Succeeded');
    });

    it('confirms a flight booking too (through the shared helper)', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 4 });
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      const paymentId = await confirmBooking(ctx, user, 'flight', hold.body._id);
      expect(await bookingStatus(user, 'flight', hold.body._id)).toBe('Confirmed');
      expect((await paymentOf(user, paymentId)).status).toBe('Succeeded');
    });

    it('an invalid signature is 400 and changes nothing', async () => {
      const { user, bookingId, intentId } = await openPayment();
      const hook = await sendWebhook(ctx, ctx.stripe.succeededEvent(intentId), 'forged');
      expect(hook.status).toBe(400);
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Pending Payment');
    });

    it('is idempotent per Stripe event id: a redelivery changes nothing and refunds nothing', async () => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      const event = ctx.stripe.succeededEvent(intentId);
      const refundsBefore = ctx.stripe.refunds.length;
      expect((await sendWebhook(ctx, event)).status).toBe(201);
      expect((await sendWebhook(ctx, event)).status).toBe(201);
      expect(await model('Payment').countDocuments({ _id: paymentId })).toBe(1);
      expect(await ctx.conn.model('StripeWebhookEvent').countDocuments({ stripeEventId: event.id })).toBe(1);
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Confirmed');
      expect((await paymentOf(user, paymentId)).status).toBe('Succeeded');
      expect(ctx.stripe.refunds.length).toBe(refundsBefore);
    });

    it('a second, different success event for an already paid intent changes nothing', async () => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      await sendWebhook(ctx, ctx.stripe.succeededEvent(intentId));
      const refundsBefore = ctx.stripe.refunds.length;
      expect((await sendWebhook(ctx, ctx.stripe.succeededEvent(intentId))).status).toBe(201);
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Confirmed');
      expect((await paymentOf(user, paymentId)).status).toBe('Succeeded');
      expect(ctx.stripe.refunds.length).toBe(refundsBefore);
    });

    it.each([
      ['amount', { amount: 450000 - 100 }],
      ['currency', { currency: 'usd' }],
    ])('a wrong %s does NOT confirm the booking', async (_name, override) => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      const hook = await sendWebhook(ctx, ctx.stripe.succeededEvent(intentId, override));
      expect(hook.status).toBe(201);
      expect(await bookingStatus(user, 'hotel', bookingId)).not.toBe('Confirmed');
      expect((await paymentOf(user, paymentId)).status).not.toBe('Succeeded');
    });

    it('an event for a PaymentIntent that is not ours does NOT confirm the booking', async () => {
      const { user, bookingId, paymentId } = await openPayment();
      // Same metadata as our payment, but a different PaymentIntent id.
      const forged: any = ctx.stripe.succeededEvent(intentIdOf(ctx, (await openPayment()).pay.body));
      forged.data.object.id = 'pi_not_ours';
      forged.data.object.metadata = { paymentId, bookingId, bookingType: 'hotel', userId: user.id };
      expect((await sendWebhook(ctx, forged)).status).toBe(201);
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Pending Payment');
      expect((await paymentOf(user, paymentId)).status).toBe('Pending');
    });

    it('a success that arrives AFTER the hold expired does not confirm the booking; the money is flagged for refund', async () => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      await lapseHold('HotelBooking', bookingId);
      await ctx.get(PaymentsService).expirePendingBookings();
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Expired');

      const hook = await sendWebhook(ctx, ctx.stripe.succeededEvent(intentId));
      expect(hook.status).toBe(201);
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Expired');
      const payment = await paymentOf(user, paymentId);
      expect(payment.status).not.toBe('Succeeded');
      // Flagged Refund Pending and handed to the existing refund path (which returns it at once when Stripe accepts).
      expect(['Refund Pending', 'Refunded']).toContain(payment.status);
      expect(payment.refundPercentage).toBe(100);
      expect(ctx.stripe.refunds.some((r) => r.paymentIntentId === intentId && r.amountMinor === 450000)).toBe(true);
    });

    it('a failed attempt marks the payment Failed and keeps the booking Pending Payment', async () => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      expect((await sendWebhook(ctx, ctx.stripe.failedEvent(intentId, 'card_declined'))).status).toBe(201);
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Pending Payment');
      expect(await paymentOf(user, paymentId)).toMatchObject({ status: 'Failed', lastFailureCode: 'card_declined' });
    });

    it('a failure event for a PaymentIntent that is not ours is ignored', async () => {
      const { user, paymentId } = await openPayment();
      const forged: any = ctx.stripe.failedEvent((await openPayment()).intentId);
      forged.data.object.id = 'pi_not_ours';
      forged.data.object.metadata = { paymentId };
      await sendWebhook(ctx, forged);
      expect((await paymentOf(user, paymentId)).status).toBe('Pending');
    });
  });

  describe('retry after a failed attempt (PAY-01)', () => {
    async function failedPayment() {
      const open = await openPayment();
      await sendWebhook(ctx, ctx.stripe.failedEvent(open.intentId));
      return open;
    }

    it('reuses the same PaymentIntent while Stripe says it is still usable, and the booking can then be paid', async () => {
      const { user, bookingId, paymentId, intentId, pay } = await failedPayment();
      const retry = await user.agent.post(`/api/payments/${paymentId}/retry`);
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ paymentId, amount: 4500, currency: 'EGP' });
      expect(intentIdOf(ctx, retry.body)).toBe(intentId);
      expect(retry.body.clientSecret).toBe(pay.body.clientSecret);
      expect((await paymentOf(user, paymentId)).status).toBe('Pending');

      await sendWebhook(ctx, ctx.stripe.succeededEvent(intentId));
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Confirmed');
    });

    it('creates a new PaymentIntent when the old one was cancelled', async () => {
      const { user, paymentId, intentId } = await failedPayment();
      ctx.stripe.intents.get(intentId)!.status = 'canceled';
      const retry = await user.agent.post(`/api/payments/${paymentId}/retry`);
      expect(retry.status).toBe(200);
      const newIntent = intentIdOf(ctx, retry.body);
      expect(newIntent).not.toBe(intentId);
      expect((await model('Payment').findById(paymentId).lean() as any).stripePaymentIntentId).toBe(newIntent);
    });

    it('is rejected (409) when the last attempt did not fail', async () => {
      const { user, paymentId } = await openPayment();
      expect((await user.agent.post(`/api/payments/${paymentId}/retry`)).status).toBe(409);
    });

    it('is rejected (409) once the hold expired', async () => {
      const { user, bookingId, paymentId } = await failedPayment();
      await lapseHold('HotelBooking', bookingId);
      const retry = await user.agent.post(`/api/payments/${paymentId}/retry`);
      expect(retry.status).toBe(409);
      expect(retry.body.message).toMatch(/hold has expired/i);
    });

    it("is 404 for another user's payment and 401 without a session", async () => {
      const { paymentId } = await failedPayment();
      expect((await (await createUser(ctx)).agent.post(`/api/payments/${paymentId}/retry`)).status).toBe(404);
      expect((await ctx.http().post(`/api/payments/${paymentId}/retry`)).status).toBe(401);
    });

    it('POST /payments points a failed payment to retry', async () => {
      const { user, bookingId } = await failedPayment();
      const res = await startPayment(user, 'hotel', bookingId);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/retry/);
    });
  });

  describe('hold expiry cancels the PaymentIntent (PAY-01)', () => {
    it('the expiry job cancels the open PaymentIntent and the payment becomes Expired', async () => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      await lapseHold('HotelBooking', bookingId);
      await ctx.get(PaymentsService).expirePendingBookings();
      expect(ctx.stripe.cancelledIntents).toContain(intentId);
      expect((await paymentOf(user, paymentId)).status).toBe('Expired');
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Expired');
      expect((await startPayment(user, 'hotel', bookingId)).status).toBe(409);
    });

    it('cancelling an unpaid booking cancels its PaymentIntent too', async () => {
      const { user, bookingId, intentId } = await openPayment();
      expect((await user.agent.post(`/api/hotel-bookings/${bookingId}/cancel`)).status).toBe(200);
      expect(ctx.stripe.cancelledIntents).toContain(intentId);
    });
  });

  describe('test-confirm (test mode only)', () => {
    it('pays with pm_card_visa but does NOT confirm the booking; only the signed webhook does', async () => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      const res = await user.agent.post(`/api/payments/${paymentId}/test-confirm`);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('succeeded');
      expect(ctx.stripe.confirmations).toContainEqual({ paymentIntentId: intentId, paymentMethod: 'pm_card_visa' });
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Pending Payment');
      expect((await paymentOf(user, paymentId)).status).toBe('Pending');

      await sendWebhook(ctx, ctx.stripe.succeededEvent(intentId));
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Confirmed');
    });

    it('{ outcome: "decline" } uses pm_card_chargeDeclined and reports a decline (200), then retry works', async () => {
      const { user, bookingId, paymentId, intentId } = await openPayment();
      const res = await user.agent.post(`/api/payments/${paymentId}/test-confirm`).send({ outcome: 'decline' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ outcome: 'declined', code: 'card_declined' });
      expect(ctx.stripe.confirmations).toContainEqual({ paymentIntentId: intentId, paymentMethod: 'pm_card_chargeDeclined' });
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Pending Payment');

      await sendWebhook(ctx, ctx.stripe.failedEvent(intentId));
      expect((await user.agent.post(`/api/payments/${paymentId}/retry`)).status).toBe(200);
      expect((await user.agent.post(`/api/payments/${paymentId}/test-confirm`)).status).toBe(200);
    });

    it('rejects an unknown outcome (400)', async () => {
      const { user, paymentId } = await openPayment();
      expect((await user.agent.post(`/api/payments/${paymentId}/test-confirm`).send({ outcome: 'refund' })).status).toBe(400);
    });

    it("is 404 for another user's payment and 401 without a session", async () => {
      const { paymentId } = await openPayment();
      expect((await (await createUser(ctx)).agent.post(`/api/payments/${paymentId}/test-confirm`)).status).toBe(404);
      expect((await ctx.http().post(`/api/payments/${paymentId}/test-confirm`)).status).toBe(401);
    });

    it('is rejected (409) for a booking that is no longer Pending Payment', async () => {
      const { user, bookingId, paymentId } = await openPayment();
      await sendWebhook(ctx, ctx.stripe.succeededEvent(intentIdOf(ctx, (await startPayment(user, 'hotel', bookingId)).body)));
      expect(await bookingStatus(user, 'hotel', bookingId)).toBe('Confirmed');
      expect((await user.agent.post(`/api/payments/${paymentId}/test-confirm`)).status).toBe(409);
    });
  });

  describe('one platform currency (PAY-04)', () => {
    const roomBody = (extra: Record<string, unknown> = {}) => ({ name: `Room ${Math.random().toString(36).slice(2, 6)}`, type: 'Standard double', beds: 1, maxOccupancy: 2, pricePerNight: 100, ...extra });
    const cabinBody = (extra: Record<string, unknown> = {}) => ({ cabinClass: 'Business', totalSeats: 4, price: 900, freeBagsCount: 2, maxWeightPerBagKg: 32, ...extra });

    it('a room in another currency is 400 on the currency field, naming the platform currency', async () => {
      const { hotelId, moderator } = await createHotelWithRooms(ctx, { rooms: 0 });
      const res = await moderator.agent.post(`/api/hotels/${hotelId}/rooms`).send(roomBody({ currency: 'USD' }));
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual([{ field: 'currency', messages: ['currency must be EGP'] }]);
    });

    it('a room without a currency gets the platform currency; the platform currency itself is accepted in any case', async () => {
      const { hotelId, moderator } = await createHotelWithRooms(ctx, { rooms: 0 });
      const omitted = await moderator.agent.post(`/api/hotels/${hotelId}/rooms`).send(roomBody());
      expect(omitted.status).toBe(201);
      expect(omitted.body.currency).toBe('EGP');
      const lower = await moderator.agent.post(`/api/hotels/${hotelId}/rooms`).send(roomBody({ currency: 'egp' }));
      expect(lower.status).toBe(201);
      expect(lower.body.currency).toBe('EGP');
    });

    it('updating a room to another currency is 400; to the platform currency is fine', async () => {
      const { hotelId, roomIds, moderator } = await createHotelWithRooms(ctx, { rooms: 1 });
      const bad = await moderator.agent.patch(`/api/hotels/${hotelId}/rooms/${roomIds[0]}`).send({ currency: 'EUR' });
      expect(bad.status).toBe(400);
      expect(bad.body.errors).toEqual([{ field: 'currency', messages: ['currency must be EGP'] }]);
      expect((await moderator.agent.patch(`/api/hotels/${hotelId}/rooms/${roomIds[0]}`).send({ currency: 'EGP' })).status).toBe(200);
    });

    it('a cabin in another currency is 400 on the currency field; without one it gets the platform currency', async () => {
      const { flightId, moderator } = await createAirlineWithFlight(ctx);
      const bad = await moderator.agent.post(`/api/flights/${flightId}/cabins`).send(cabinBody({ currency: 'USD' }));
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain('currency must be EGP');
      const ok = await moderator.agent.post(`/api/flights/${flightId}/cabins`).send(cabinBody());
      expect(ok.status).toBe(201);
      expect(ok.body.currency).toBe('EGP');
    });

    it('updating a cabin to another currency is 400', async () => {
      const { flightId, moderator } = await createAirlineWithFlight(ctx);
      const cabins = await moderator.agent.get(`/api/flights/${flightId}/cabins`);
      const cabinId = idOf((Array.isArray(cabins.body) ? cabins.body : cabins.body.items)[0]);
      const bad = await moderator.agent.patch(`/api/flights/${flightId}/cabins/${cabinId}`).send({ currency: 'EUR' });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain('currency must be EGP');
      expect((await moderator.agent.patch(`/api/flights/${flightId}/cabins/${cabinId}`).send({ currency: 'EGP' })).status).toBe(200);
    });

    it('a booking priced in another currency (old data) cannot be paid', async () => {
      const { user, bookingId } = await hotelHold();
      await model('HotelBooking').updateOne({ _id: bookingId }, { $set: { currency: 'USD' } });
      const res = await startPayment(user, 'hotel', bookingId);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/platform currency EGP/);
    });
  });
});
