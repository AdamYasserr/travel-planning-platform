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
  describe('flight cancellation by the airline (FLT-06)', () => {
    /** A flight with: two Confirmed bookings, one open hold with a payment, one Completed booking. */
    async function bookedFlight() {
      const fixture = await createAirlineWithFlight(ctx, { seats: 10, price: 5000 });
      const [a, b, c, d] = [await createUser(ctx), await createUser(ctx), await createUser(ctx), await createUser(ctx)];
      const holdA = await holdFlight(a, { flightId: fixture.flightId });
      const holdB = await holdFlight(b, { flightId: fixture.flightId, passengers: 2 });
      const holdC = await holdFlight(c, { flightId: fixture.flightId });
      const holdD = await holdFlight(d, { flightId: fixture.flightId });
      const payA = await confirmBooking(ctx, a, 'flight', holdA.body._id);
      const payB = await confirmBooking(ctx, b, 'flight', holdB.body._id);
      const payC = await startPayment(c, 'flight', holdC.body._id);
      const payD = await confirmBooking(ctx, d, 'flight', holdD.body._id);
      await model('FlightBooking').updateOne({ _id: holdD.body._id }, { $set: { status: 'Completed' } });
      return { ...fixture, a, b, c, d, holdA, holdB, holdC, holdD, payA, payB, payC, payD };
    }
    const seatsLeft = async (flightId: string) => ((await model('CabinInventory').findOne({ flightId }).lean()) as any).availableSeats;

    it('cancels the flight, refunds every Confirmed booking 100%, expires holds and leaves Completed ones alone', async () => {
      const f = await bookedFlight();
      const res = await f.moderator.agent.post(`/api/flights/${f.flightId}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ cancelledBookings: 2, expiredHolds: 1, refunds: 2 });
      expect(res.body.flight.status).toBe('Cancelled');

      for (const [user, hold, paymentId, minor] of [[f.a, f.holdA, f.payA, 500000], [f.b, f.holdB, f.payB, 1000000]] as const) {
        expect((await user.agent.get(`/api/flight-bookings/${hold.body._id}`)).body.status).toBe('Cancelled');
        const payment = (await user.agent.get(`/api/payments/${paymentId}`)).body;
        expect(payment.status).toBe('Refunded');
        expect((await refundOf(user, payment.refundId)).body).toMatchObject({ percentage: 100, amountMinor: minor, reason: 'flight_cancelled', status: 'Refunded' });
        expect(stripeCallsFor(paymentId)).toBe(1);
      }
      expect((await f.c.agent.get(`/api/flight-bookings/${f.holdC.body._id}`)).body.status).toBe('Expired');
      expect(ctx.stripe.cancelledIntents).toContain(intentIdOf(ctx, f.payC.body));
      expect((await f.c.agent.get(`/api/payments/${f.payC.body.paymentId}`)).body.status).toBe('Expired');
      expect((await f.d.agent.get(`/api/flight-bookings/${f.holdD.body._id}`)).body.status).toBe('Completed');
      expect(stripeCallsFor(f.payD)).toBe(0);
    });

    it('a cancelled flight disappears from search and cannot be booked', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 4, departInDays: 45 });
      const search = () => ctx.http().get('/api/flights/search').query({ origin: 'CAI', destination: 'DXB', departureDate: day(45), limit: 100 });
      expect(JSON.stringify((await search()).body)).toContain(f.flightId);
      expect((await f.moderator.agent.post(`/api/flights/${f.flightId}/cancel`)).status).toBe(200);
      expect(JSON.stringify((await search()).body)).not.toContain(f.flightId);
      expect((await holdFlight(await createUser(ctx), { flightId: f.flightId })).status).toBe(409);
    });

    it('cancelling again is 409 and creates no second refund', async () => {
      const f = await bookedFlight();
      expect((await f.moderator.agent.post(`/api/flights/${f.flightId}/cancel`)).status).toBe(200);
      expect((await f.moderator.agent.post(`/api/flights/${f.flightId}/cancel`)).status).toBe(409);
      expect(stripeCallsFor(f.payA)).toBe(1);
      expect(await model('Refund').countDocuments({ paymentId: f.payA })).toBe(1);
    });

    it('only the airline\'s moderator or an admin may cancel; others are 403 and change nothing', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 4 });
      const other = await createAirlineWithFlight(ctx, { seats: 4 });
      expect((await other.moderator.agent.post(`/api/flights/${f.flightId}/cancel`)).status).toBe(403);
      expect((await (await createUser(ctx)).agent.post(`/api/flights/${f.flightId}/cancel`)).status).toBe(403);
      expect((await ctx.http().post(`/api/flights/${f.flightId}/cancel`)).status).toBe(401);
      expect((await f.moderator.agent.post('/api/flights/not-an-id/cancel')).status).toBe(400);
      expect(((await model('Flight').findById(f.flightId).lean()) as any).status).toBe('Scheduled');
      expect((await (await createUser(ctx, 'admin')).agent.post(`/api/flights/${f.flightId}/cancel`)).status).toBe(200);
    });

    it('seats of the cancelled bookings and holds are released', async () => {
      const f = await bookedFlight();
      const before = await seatsLeft(f.flightId);
      await f.moderator.agent.post(`/api/flights/${f.flightId}/cancel`);
      // A (1), B (2) and the hold C (1) give their seats back; the Completed booking keeps its seat.
      expect(await seatsLeft(f.flightId)).toBe(before + 4);
    });
  });
  describe('notifications (GEN-01)', () => {
    const inbox = async (user: TestUser, query = '') => (await user.agent.get(`/api/notifications${query}`)).body;
    const types = async (user: TestUser) => (await inbox(user, '?limit=100')).items.map((n: any) => n.type);

    it('a confirmed booking notifies its owner only', async () => {
      const { user, bookingId } = await paidHotel();
      const stranger = await createUser(ctx);
      const mine = await inbox(user);
      expect(mine.items[0]).toMatchObject({ type: 'booking_confirmed', title: 'Booking confirmed', isRead: false, resourceType: 'booking', resourceId: bookingId });
      expect(mine.items[0].payload).toMatchObject({ bookingType: 'hotel', bookingId, amountMinor: 450000, currency: 'egp' });
      expect((await inbox(stranger)).total).toBe(0);
    });

    it('a customer cancel notifies: booking cancelled, refund started, refund completed (newest first)', async () => {
      const { user, bookingId } = await paidHotel();
      const { refundId } = (await cancelHotel(user, bookingId)).body;
      const list = (await inbox(user)).items;
      expect(list.slice(0, 3).map((n: any) => n.type)).toEqual(['refund_refunded', 'refund_created', 'booking_cancelled']);
      expect(list[0].payload).toMatchObject({ refundId, amountMinor: 450000, status: 'Refunded' });
      expect(list[2].payload).toMatchObject({ bookingId, refundPercentage: 100, refundId });
    });

    it('a failed refund notifies the user, once', async () => {
      const { user, bookingId, paymentId } = await paidHotel();
      ctx.stripe.nextRefundOutcomes.push('pending');
      await cancelHotel(user, bookingId);
      const event = ctx.stripe.refundEvent(ctx.stripe.stripeRefundFor(paymentId)!.id, 'failed');
      await sendWebhook(ctx, event);
      await sendWebhook(ctx, event);
      expect((await types(user)).filter((t: string) => t === 'refund_failed')).toHaveLength(1);
      expect(await types(user)).not.toContain('refund_refunded');
    });

    it('a 0% cancel notifies the cancellation and no refund', async () => {
      const { user, bookingId } = await paidHotel({ checkIn: 3 });
      await cancelHotel(user, bookingId);
      const all = await types(user);
      expect(all).toContain('booking_cancelled');
      expect(all).not.toContain('refund_created');
    });

    it('a cancelled flight notifies every affected booking, and nobody else', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6 });
      const [a, held, done, other] = [await createUser(ctx), await createUser(ctx), await createUser(ctx), await createUser(ctx)];
      const hA = await holdFlight(a, { flightId: f.flightId });
      await confirmBooking(ctx, a, 'flight', hA.body._id);
      await holdFlight(held, { flightId: f.flightId });
      const hD = await holdFlight(done, { flightId: f.flightId });
      await confirmBooking(ctx, done, 'flight', hD.body._id);
      await model('FlightBooking').updateOne({ _id: hD.body._id }, { $set: { status: 'Completed' } });

      await f.moderator.agent.post(`/api/flights/${f.flightId}/cancel`);
      expect(await types(a)).toEqual(expect.arrayContaining(['flight_cancelled', 'refund_created', 'refund_refunded']));
      const cancelledNote = (await inbox(a, '?limit=100')).items.find((n: any) => n.type === 'flight_cancelled');
      expect(cancelledNote.payload).toMatchObject({ flightId: f.flightId, bookingId: hA.body._id });
      expect(await types(held)).toEqual(['flight_cancelled']);
      expect(await types(done)).not.toContain('flight_cancelled');
      expect((await inbox(other)).total).toBe(0);
    });

    it('a new departure or arrival time notifies Confirmed bookings only; other edits notify nobody', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6, departInDays: 50 });
      const [confirmed, pending] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdFlight(confirmed, { flightId: f.flightId });
      await confirmBooking(ctx, confirmed, 'flight', hold.body._id);
      await holdFlight(pending, { flightId: f.flightId });

      expect((await f.moderator.agent.patch(`/api/flights/${f.flightId}`).send({ flightNumber: `${f.airlineId.slice(-2).toUpperCase()}777` })).status).toBe(200);
      expect(await types(confirmed)).not.toContain('flight_schedule_changed');

      const depart = new Date(`${day(50)}T10:30:00.000Z`);
      const arrive = new Date(depart.getTime() + 4 * 3_600_000);
      const res = await f.moderator.agent.patch(`/api/flights/${f.flightId}`).send({ departureTime: depart.toISOString(), arrivalTime: arrive.toISOString() });
      expect(res.status).toBe(200);
      const note = (await inbox(confirmed)).items[0];
      expect(note).toMatchObject({ type: 'flight_schedule_changed' });
      expect(note.payload).toMatchObject({ flightId: f.flightId, bookingId: hold.body._id, departureTime: depart.toISOString() });
      expect((await inbox(pending)).total).toBe(0);
    });

    it('suspending and reactivating an account notifies that user', async () => {
      const admin = await createUser(ctx, 'admin');
      const user = await createUser(ctx);
      expect((await admin.agent.patch(`/api/admin/accounts/${user.id}/suspend`)).status).toBe(200);
      expect((await admin.agent.patch(`/api/admin/accounts/${user.id}/reactivate`)).status).toBe(200);
      const fresh = { ...user, agent: (await (await import('./helpers/factories')).login(ctx, user.email)) };
      expect(await types(fresh)).toEqual(['account_reactivated', 'account_suspended']);
    });

    it('lists 10 per page by default, newest first, and accepts limit up to 100', async () => {
      const admin = await createUser(ctx, 'admin');
      const user = await createUser(ctx);
      for (let i = 0; i < 6; i++) {
        await admin.agent.patch(`/api/admin/accounts/${user.id}/suspend`);
        await admin.agent.patch(`/api/admin/accounts/${user.id}/reactivate`);
      }
      const agent = (await import('./helpers/factories')).login(ctx, user.email);
      const page1 = (await (await agent).get('/api/notifications')).body;
      expect(page1).toMatchObject({ page: 1, limit: 10, total: 12, unread: 12, pages: 2 });
      expect(page1.items).toHaveLength(10);
      expect(page1.items[0].type).toBe('account_reactivated');
      const times = page1.items.map((n: any) => new Date(n.createdAt).getTime());
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      expect((await (await agent).get('/api/notifications?page=2')).body.items).toHaveLength(2);
      expect((await (await agent).get('/api/notifications?limit=101')).status).toBe(400);
    });

    it('mark one read, mark all read, and only for your own notifications', async () => {
      const { user } = await paidHotel();
      const { user: other } = await paidHotel();
      const [note] = (await inbox(user)).items;

      expect((await other.agent.patch(`/api/notifications/${note._id}/read`)).status).toBe(404);
      expect((await user.agent.patch('/api/notifications/not-an-id/read')).status).toBe(400);
      expect((await ctx.http().patch(`/api/notifications/${note._id}/read`)).status).toBe(401);

      const read = await user.agent.patch(`/api/notifications/${note._id}/read`);
      expect(read.status).toBe(200);
      expect(read.body.isRead).toBe(true);

      await cancelHotel(user, (await model('HotelBooking').findOne({ userId: user.id }).lean() as any)._id);
      expect((await inbox(user)).unread).toBeGreaterThan(0);
      const all = await user.agent.patch('/api/notifications/read-all');
      expect(all.status).toBe(200);
      expect(all.body.updated).toBeGreaterThan(0);
      expect((await inbox(user)).unread).toBe(0);
      expect((await inbox(other)).unread).toBe(1);
      expect((await ctx.http().patch('/api/notifications/read-all')).status).toBe(401);
    });
  });
  describe('e-ticket PDF (FLT-23)', () => {
    /** supertest: keep the PDF as bytes. */
    const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const ticket = (agent: any, id: string) => agent.get(`/api/bookings/${id}/e-ticket`).buffer(true).parse(binary);

    async function confirmedFlight() {
      const f = await createAirlineWithFlight(ctx, { seats: 4 });
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId: f.flightId, passengers: 2 });
      await confirmBooking(ctx, user, 'flight', hold.body._id);
      return { ...f, user, bookingId: String(hold.body._id), hold };
    }

    it('the owner downloads a PDF attachment for a Confirmed booking', async () => {
      const { user, bookingId, hold } = await confirmedFlight();
      const res = await ticket(user.agent, bookingId);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="e-ticket-${hold.body.reference}.pdf"`);
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(res.body.length).toBeGreaterThan(1000);
    });

    it('a Completed booking still has its ticket, and an admin may download any', async () => {
      const { user, bookingId } = await confirmedFlight();
      await model('FlightBooking').updateOne({ _id: bookingId }, { $set: { status: 'Completed' } });
      expect((await ticket(user.agent, bookingId)).status).toBe(200);
      expect((await ticket((await createUser(ctx, 'admin')).agent, bookingId)).status).toBe(200);
    });

    it('is 409 for a booking that is Pending Payment, Expired or Cancelled', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6 });
      const user = await createUser(ctx);
      const pending = await holdFlight(user, { flightId: f.flightId });
      expect((await ticket(user.agent, pending.body._id)).status).toBe(409);
      const lapsed = await holdFlight(user, { flightId: f.flightId });
      await model('FlightBooking').updateOne({ _id: lapsed.body._id }, { $set: { status: 'Expired' } });
      expect((await ticket(user.agent, lapsed.body._id)).status).toBe(409);
      const { user: owner, bookingId } = await confirmedFlight();
      await model('FlightBooking').updateOne({ _id: bookingId }, { $set: { status: 'Cancelled' } });
      expect((await ticket(owner.agent, bookingId)).status).toBe(409);
    });

    it("another user's booking and a hotel booking are 404; signed out is 401; a bad id is 400", async () => {
      const { bookingId } = await confirmedFlight();
      const stranger = await createUser(ctx);
      expect((await ticket(stranger.agent, bookingId)).status).toBe(404);
      expect((await ticket((await createUser(ctx, 'moderator')).agent, bookingId)).status).toBe(404);
      const hotel = await paidHotel();
      expect((await ticket(hotel.user.agent, hotel.bookingId)).status).toBe(404);
      expect((await ctx.http().get(`/api/bookings/${bookingId}/e-ticket`)).status).toBe(401);
      expect((await stranger.agent.get('/api/bookings/not-an-id/e-ticket')).status).toBe(400);
    });
  });
});
