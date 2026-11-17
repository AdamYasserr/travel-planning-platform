import { PaymentsService } from '../../src/modules/payments/payments.service';
import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdFlight, holdHotel, intentIdOf, startPayment } from './helpers/bookings';
import { createAirlineWithFlight, createHotelWithRooms, createUser, day } from './helpers/factories';
import { seedReference } from './helpers/reference';

const TEN_MINUTES = 10 * 60 * 1000;

describe('holds, expiry and cancellation (HTL-16/18, FLT-22, GEN-11)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  const expectTenMinuteHold = (holdExpiresAt: string) => {
    const remaining = new Date(holdExpiresAt).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(TEN_MINUTES - 30_000);
    expect(remaining).toBeLessThanOrEqual(TEN_MINUTES);
  };

  describe('hotel holds', () => {
    it('a hotel hold is Pending Payment and expires in 10 minutes', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const res = await holdHotel(user, { hotelId, roomIds });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('Pending Payment');
      expectTenMinuteHold(res.body.holdExpiresAt);
    });

    it('an overlapping hold on the same room gives 409', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const [a, b] = [await createUser(ctx), await createUser(ctx)];
      expect((await holdHotel(a, { hotelId, roomIds, checkIn: day(10), checkOut: day(13) })).status).toBe(201);
      expect((await holdHotel(b, { hotelId, roomIds, checkIn: day(12), checkOut: day(15) })).status).toBe(409);
      // back-to-back stays do not overlap
      expect((await holdHotel(b, { hotelId, roomIds, checkIn: day(13), checkOut: day(15) })).status).toBe(201);
    });

    it('a 3-room booking with one room already held holds nothing', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 3 });
      const [holder, bulk, other] = [await createUser(ctx), await createUser(ctx), await createUser(ctx)];
      expect((await holdHotel(holder, { hotelId, roomIds: [roomIds[1]] })).status).toBe(201);

      expect((await holdHotel(bulk, { hotelId, roomIds })).status).toBe(409);
      const bulkBookings = await ctx.conn.model('HotelBooking').countDocuments({ userId: bulk.id });
      expect(bulkBookings).toBe(0);
      // rooms 0 and 2 were not left held by the failed request
      expect((await holdHotel(other, { hotelId, roomIds: [roomIds[0], roomIds[2]] })).status).toBe(201);
    });

    it('a 3-room booking holds all three rooms as ONE reservation', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 3 });
      const user = await createUser(ctx);
      const res = await holdHotel(user, { hotelId, roomIds });
      expect(res.status).toBe(201);
      expect(res.body.rooms).toHaveLength(3);
      expect(await ctx.conn.model('HotelBooking').countDocuments({ userId: user.id })).toBe(1);
    });

    it('two REAL concurrent requests for the same room give exactly one 201 and one 409', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 5 });
      for (const roomId of roomIds) {
        const [a, b] = [await createUser(ctx), await createUser(ctx)];
        const results = await Promise.all([
          holdHotel(a, { hotelId, roomIds: [roomId] }),
          holdHotel(b, { hotelId, roomIds: [roomId] }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      }
      expect(await ctx.conn.model('HotelBooking').countDocuments({ hotelId })).toBe(5);
    });

    it.each([
      ['check-out not after check-in', { checkIn: day(10), checkOut: day(10) }],
      ['check-out before check-in', { checkIn: day(12), checkOut: day(10) }],
      ['check-in in the past', { checkIn: day(-2), checkOut: day(2) }],
      ['malformed date', { checkIn: '10/12/2030', checkOut: day(13) }],
    ])('invalid dates give 400: %s', async (_name, dates) => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      expect((await holdHotel(user, { hotelId, roomIds, ...dates })).status).toBe(400);
    });

    it('policies may be accepted later: a hold without acceptance is created unaccepted (PAY-02)', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const res = await holdHotel(user, { hotelId, roomIds, body: { policiesAccepted: false } });
      expect(res.status).toBe(201);
      expect(res.body.policiesAcceptedAt ?? null).toBeNull();
    });

    it('dates outside the room availability range give 409', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1, availability: { startDate: day(20), endDate: day(30) } });
      const user = await createUser(ctx);
      expect((await holdHotel(user, { hotelId, roomIds, checkIn: day(10), checkOut: day(13) })).status).toBe(409);
    });

    it('cancelling an unpaid hold gives Expired and frees the room', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const [a, b] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdHotel(a, { hotelId, roomIds });
      expect((await holdHotel(b, { hotelId, roomIds })).status).toBe(409);

      const cancel = await a.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`);
      expect(cancel.status).toBe(200);
      expect(cancel.body.booking.status).toBe('Expired');
      expect((await holdHotel(b, { hotelId, roomIds })).status).toBe(201);
    });

    it('cancelling an unpaid hold with an open payment also cancels its PaymentIntent', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const hold = await holdHotel(user, { hotelId, roomIds });
      const pay = await startPayment(user, 'hotel', hold.body._id);
      expect(pay.status).toBeLessThan(300);

      const cancel = await user.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`);
      expect(cancel.status).toBe(200);
      expect(cancel.body.booking.status).toBe('Expired');
      expect(ctx.stripe.cancelledIntents).toContain(intentIdOf(ctx, pay.body));
    });

    it('a lapsed hold stops blocking, and the expiry job marks it Expired', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const [a, b] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdHotel(a, { hotelId, roomIds });
      await ctx.conn.model('HotelBooking').updateOne({ _id: hold.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });

      // frees the room even before the job runs
      expect((await holdHotel(b, { hotelId, roomIds })).status).toBe(201);

      await ctx.get(PaymentsService).expirePendingBookings();
      const stored = await a.agent.get(`/api/hotel-bookings/${hold.body._id}`);
      expect(stored.body.status).toBe('Expired');
    });

    it('blocking a range over a held range is rejected', async () => {
      const { hotelId, roomIds, moderator } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      expect((await holdHotel(user, { hotelId, roomIds, checkIn: day(10), checkOut: day(13) })).status).toBe(201);

      const block = await moderator.agent
        .patch(`/api/hotels/${hotelId}/rooms/${roomIds[0]}/blocks`)
        .send({ blockedRanges: [{ startDate: day(11), endDate: day(12) }] });
      expect(block.status).toBe(409);
      // a range elsewhere is fine
      const free = await moderator.agent
        .patch(`/api/hotels/${hotelId}/rooms/${roomIds[0]}/blocks`)
        .send({ blockedRanges: [{ startDate: day(20), endDate: day(22) }] });
      expect(free.status).toBe(200);
    });

    it('a blocked range stops holds on it', async () => {
      const { hotelId, roomIds, moderator } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      await moderator.agent.patch(`/api/hotels/${hotelId}/rooms/${roomIds[0]}/blocks`).send({ blockedRanges: [{ startDate: day(10), endDate: day(14) }] });
      expect((await holdHotel(user, { hotelId, roomIds, checkIn: day(11), checkOut: day(12) })).status).toBe(409);
    });

    it('a Confirmed booking blocks the room; cancelling it frees the room', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const [a, b] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdHotel(a, { hotelId, roomIds });
      await confirmBooking(ctx, a, 'hotel', hold.body._id);
      expect((await a.agent.get(`/api/hotel-bookings/${hold.body._id}`)).body.status).toBe('Confirmed');
      expect((await holdHotel(b, { hotelId, roomIds })).status).toBe(409);

      const first = await a.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`);
      expect(first.status).toBe(200);
      expect(first.body.booking.status).toBe('Cancelled');
      expect((await holdHotel(b, { hotelId, roomIds })).status).toBe(201);
    });

    it('cancelling a Cancelled booking again is rejected (409) and never creates a second refund', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const hold = await holdHotel(user, { hotelId, roomIds });
      await confirmBooking(ctx, user, 'hotel', hold.body._id);
      expect((await user.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`)).status).toBe(200);
      const refundsAfterFirst = ctx.stripe.refunds.length;
      const second = await user.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`);
      expect(second.status).toBe(409);
      expect(second.body.message).toMatch(/already cancelled/i);
      const third = await user.agent.delete(`/api/hotel-bookings/${hold.body._id}`);
      expect(third.status).toBe(409);
      expect(ctx.stripe.refunds.length).toBe(refundsAfterFirst);
      expect(await ctx.conn.model('Payment').countDocuments({ bookingId: hold.body._id })).toBe(1);
    });

    it('cancelling an expired hold twice is rejected', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const hold = await holdHotel(user, { hotelId, roomIds });
      expect((await user.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`)).status).toBe(200);
      expect((await user.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`)).status).toBe(409);
    });

    it("another user cannot cancel someone else's hold (404)", async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const [owner, stranger] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdHotel(owner, { hotelId, roomIds });
      expect((await stranger.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`)).status).toBe(404);
    });
  });

  describe('flight holds', () => {
    it('a flight hold is Pending Payment, expires in 10 minutes and takes the seats', async () => {
      const { flightId, seats } = await createAirlineWithFlight(ctx, { seats: 5 });
      const user = await createUser(ctx);
      const res = await holdFlight(user, { flightId, passengers: 2 });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('Pending Payment');
      expectTenMinuteHold(res.body.holdExpiresAt);

      // public route: no login needed
      const cabins = await ctx.http().get(`/api/flights/${flightId}/cabins`);
      expect(cabins.body).toEqual([expect.objectContaining({ availableSeats: seats - 2 })]);
    });

    it('holding more seats than are left gives 409', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 2 });
      const [a, b] = [await createUser(ctx), await createUser(ctx)];
      expect((await holdFlight(a, { flightId, passengers: 2 })).status).toBe(201);
      expect((await holdFlight(b, { flightId, passengers: 1 })).status).toBe(409);
    });

    it('two REAL concurrent requests for the last seat give exactly one 201 and one 409', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 1 });
      const [a, b] = [await createUser(ctx), await createUser(ctx)];
      const results = await Promise.all([holdFlight(a, { flightId }), holdFlight(b, { flightId })]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    });

    it('cancelling an unpaid flight hold gives Expired and returns the seats', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 1 });
      const [a, b] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdFlight(a, { flightId });
      expect((await holdFlight(b, { flightId })).status).toBe(409);

      const cancel = await a.agent.post(`/api/flight-bookings/${hold.body._id}/cancel`);
      expect(cancel.status).toBe(200);
      expect(cancel.body.booking.status).toBe('Expired');
      expect((await holdFlight(b, { flightId })).status).toBe(201);
    });

    it('a lapsed flight hold is released by the expiry job', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 1 });
      const [a, b] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdFlight(a, { flightId });
      await ctx.conn.model('FlightBooking').updateOne({ _id: hold.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      await ctx.get(PaymentsService).expirePendingBookings();
      expect((await a.agent.get(`/api/flight-bookings/${hold.body._id}`)).body.status).toBe('Expired');
      expect((await holdFlight(b, { flightId })).status).toBe(201);
    });

    it('cancelling a Cancelled flight booking again is rejected (409) and never creates a second refund', async () => {
      const { airlineId, flightId, moderator } = await createAirlineWithFlight(ctx, { seats: 2 });
      const policy = await moderator.agent.put(`/api/airlines/${airlineId}/cancellation-policy`).send({ tiers: [{ daysBeforeDeparture: 7, refundPercentage: 100 }, { daysBeforeDeparture: 0, refundPercentage: 0 }] });
      expect(policy.status).toBeLessThan(300);
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      await confirmBooking(ctx, user, 'flight', hold.body._id);
      const first = await user.agent.post(`/api/flight-bookings/${hold.body._id}/cancel`);
      expect(first.status).toBe(200);
      expect(first.body.booking.status).toBe('Cancelled');
      const refundsAfterFirst = ctx.stripe.refunds.length;
      expect(refundsAfterFirst).toBeGreaterThan(0);

      const second = await user.agent.post(`/api/flight-bookings/${hold.body._id}/cancel`);
      expect(second.status).toBe(409);
      expect(second.body.message).toMatch(/already cancelled/i);
      expect((await user.agent.delete(`/api/flight-bookings/${hold.body._id}`)).status).toBe(409);
      expect(ctx.stripe.refunds.length).toBe(refundsAfterFirst);
      expect(await ctx.conn.model('Payment').countDocuments({ bookingId: hold.body._id })).toBe(1);
    });

    it('cancelling a flight hold twice is rejected', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 2 });
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      expect((await user.agent.post(`/api/flight-bookings/${hold.body._id}/cancel`)).status).toBe(200);
      expect((await user.agent.post(`/api/flight-bookings/${hold.body._id}/cancel`)).status).toBe(409);
    });

    it('POST /flight-bookings/hold behaves like POST /flight-bookings', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 4 });
      const user = await createUser(ctx);
      const res = await user.agent.post('/api/flight-bookings/hold').send({
        flightId, cabinClass: 'Economy', passengers: [{ fullName: 'A B', dateOfBirth: '1990-01-01' }], policiesAccepted: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('Pending Payment');
    });
  });
});
