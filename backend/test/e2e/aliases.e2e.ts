import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdFlight, holdHotel, startPayment } from './helpers/bookings';
import { StripeFake } from './helpers/fakes';
import { createAirlineWithFlight, createHotelWithRooms, createUser, day, idOf, type TestUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

/** Responses are "the same" when status and body match once ids and timestamps are masked. */
const normalize = (body: unknown) =>
  JSON.stringify(body)
    .replace(/[0-9a-f]{24}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
    .replace(/(HTL|FLT)-[0-9a-f-]{36}/g, '$1-<ref>');
const expectSame = (alias: { status: number; body: unknown }, original: { status: number; body: unknown }) => {
  expect(alias.status).toBe(original.status);
  expect(normalize(alias.body)).toBe(normalize(original.body));
};

describe('PDF route aliases return the same as the original routes (Section 8)', () => {
  let ctx: E2EContext;
  beforeAll(async () => {
    ctx = await startApp({ swagger: true });
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  // ---------- itineraries ----------
  interface ItineraryFixture { id: string; days: string[]; activityId: string; budgetId: string; transportId: string }

  async function newItinerary(user: TestUser): Promise<ItineraryFixture> {
    const created = await user.agent.post('/api/itineraries').send({ title: 'Trip', countryIds: ['EG', 'AE'], startDate: day(20), endDate: day(30) });
    if (created.status !== 201) throw new Error(`itinerary create failed: ${created.status} ${JSON.stringify(created.body)}`);
    const id = idOf(created.body);
    const days: string[] = [];
    for (const cityId of ['cairo', 'dubai']) {
      const res = await user.agent.post(`/api/itineraries/${id}/days`).send({ cityId });
      if (res.status !== 201) throw new Error(`day create failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const stored: any = await ctx.conn.model('Itinerary').findById(id).lean();
    for (const d of stored.days) days.push(String(d._id));
    const activity = await user.agent.post(`/api/itineraries/${id}/days/${days[0]}/activities`).send({ name: 'Pyramids', description: 'Visit', time: '10:00', cost: 10 });
    const budget = await user.agent.post(`/api/itineraries/${id}/days/${days[0]}/budgets`).send({ description: 'Lunch', category: 'food', amount: 25, currency: 'EGP', type: 'planned' });
    const transport = await user.agent.post(`/api/itineraries/${id}/transport-costs`).send({ mode: 'Train', fromCityId: 'cairo', toCityId: 'dubai', amount: 40, currency: 'EGP', dayId: days[1] });
    for (const [what, res] of [['activity', activity], ['budget', budget], ['transport', transport]] as const) {
      if (res.status !== 201) throw new Error(`${what} create failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const after: any = await ctx.conn.model('Itinerary').findById(id).lean();
    return {
      id, days,
      activityId: String(after.days[0].activities[0]._id),
      budgetId: String(after.days[0].budgets[0]._id),
      transportId: String(after.transportCosts[0]._id),
    };
  }
  const view = async (user: TestUser, id: string) => (await user.agent.get(`/api/itineraries/${id}`)).body;

  describe('itineraries', () => {
    it('PATCH /itineraries/:id/days/reorder returns the same as /days/order', async () => {
      const user = await createUser(ctx);
      const [a, b] = [await newItinerary(user), await newItinerary(user)];
      const alias = await user.agent.patch(`/api/itineraries/${a.id}/days/reorder`).send({ dayIds: [...a.days].reverse() });
      const original = await user.agent.patch(`/api/itineraries/${b.id}/days/order`).send({ dayIds: [...b.days].reverse() });
      expect(alias.status).toBeLessThan(300);
      expectSame(alias, original);
      expect(normalize(await view(user, a.id))).toBe(normalize(await view(user, b.id)));
      const stored: any = await ctx.conn.model('Itinerary').findById(a.id).lean();
      expect(stored.days.map((d: any) => String(d._id))).toEqual([...a.days].reverse());
    });

    it('PATCH /activities/:id returns the same as the nested route', async () => {
      const user = await createUser(ctx);
      const [a, b] = [await newItinerary(user), await newItinerary(user)];
      const body = { name: 'Giza', cost: 99 };
      const alias = await user.agent.patch(`/api/activities/${a.activityId}`).send(body);
      const original = await user.agent.patch(`/api/itineraries/${b.id}/days/${b.days[0]}/activities/${b.activityId}`).send(body);
      expect(alias.status).toBeLessThan(300);
      expectSame(alias, original);
      expect(normalize(await view(user, a.id))).toBe(normalize(await view(user, b.id)));
    });

    it('DELETE /activities/:id returns the same as the nested route', async () => {
      const user = await createUser(ctx);
      const [a, b] = [await newItinerary(user), await newItinerary(user)];
      const alias = await user.agent.delete(`/api/activities/${a.activityId}`);
      const original = await user.agent.delete(`/api/itineraries/${b.id}/days/${b.days[0]}/activities/${b.activityId}`);
      expect(alias.status).toBeLessThan(300);
      expectSame(alias, original);
      expect(normalize(await view(user, a.id))).toBe(normalize(await view(user, b.id)));
      const stored: any = await ctx.conn.model('Itinerary').findById(a.id).lean();
      expect(stored.days[0].activities).toHaveLength(0);
    });

    it('PATCH /budgets/:id returns the same as the nested route', async () => {
      const user = await createUser(ctx);
      const [a, b] = [await newItinerary(user), await newItinerary(user)];
      const body = { amount: 30, description: 'Big lunch' };
      const alias = await user.agent.patch(`/api/budgets/${a.budgetId}`).send(body);
      const original = await user.agent.patch(`/api/itineraries/${b.id}/days/${b.days[0]}/budget-entries/${b.budgetId}`).send(body);
      expect(alias.status).toBeLessThan(300);
      expectSame(alias, original);
      expect(normalize(await view(user, a.id))).toBe(normalize(await view(user, b.id)));
    });

    it('DELETE /budgets/:id returns the same as the nested route', async () => {
      const user = await createUser(ctx);
      const [a, b] = [await newItinerary(user), await newItinerary(user)];
      const alias = await user.agent.delete(`/api/budgets/${a.budgetId}`);
      const original = await user.agent.delete(`/api/itineraries/${b.id}/days/${b.days[0]}/budget-entries/${b.budgetId}`);
      expect(alias.status).toBeLessThan(300);
      expectSame(alias, original);
      expect(normalize(await view(user, a.id))).toBe(normalize(await view(user, b.id)));
    });

    it('PATCH /transport-costs/:id returns the same as the nested route', async () => {
      const user = await createUser(ctx);
      const [a, b] = [await newItinerary(user), await newItinerary(user)];
      const body = { amount: 55, mode: 'Bus' };
      const alias = await user.agent.patch(`/api/transport-costs/${a.transportId}`).send(body);
      const original = await user.agent.patch(`/api/itineraries/${b.id}/transport-costs/${b.transportId}`).send(body);
      expect(alias.status).toBeLessThan(300);
      expectSame(alias, original);
      expect(normalize(await view(user, a.id))).toBe(normalize(await view(user, b.id)));
    });

    it('DELETE /transport-costs/:id returns the same as the nested route', async () => {
      const user = await createUser(ctx);
      const [a, b] = [await newItinerary(user), await newItinerary(user)];
      const alias = await user.agent.delete(`/api/transport-costs/${a.transportId}`);
      const original = await user.agent.delete(`/api/itineraries/${b.id}/transport-costs/${b.transportId}`);
      expect(alias.status).toBeLessThan(300);
      expectSame(alias, original);
      expect(normalize(await view(user, a.id))).toBe(normalize(await view(user, b.id)));
    });

    it('POST /itineraries/:id/days/:dayId/budgets returns the same as /budget-entries', async () => {
      const user = await createUser(ctx);
      const [a, b] = [await newItinerary(user), await newItinerary(user)];
      const body = { description: 'Dinner', category: 'food', amount: 60, currency: 'EGP', type: 'actual' };
      const alias = await user.agent.post(`/api/itineraries/${a.id}/days/${a.days[0]}/budgets`).send(body);
      const original = await user.agent.post(`/api/itineraries/${b.id}/days/${b.days[0]}/budget-entries`).send(body);
      expect(alias.status).toBe(201);
      expectSame(alias, original);
      expect(normalize(await view(user, a.id))).toBe(normalize(await view(user, b.id)));
    });

    it.each([undefined, 'USD'])('GET /itineraries/:id/budget-summary equals the budgetSummary of GET /itineraries/:id (currency=%s)', async (currency) => {
      const user = await createUser(ctx);
      const it = await newItinerary(user);
      const query = currency ? `?currency=${currency}` : '';
      const summary = await user.agent.get(`/api/itineraries/${it.id}/budget-summary${query}`);
      const full = await user.agent.get(`/api/itineraries/${it.id}${query}`);
      expect(summary.status).toBe(200);
      const { itineraryId, ...totals } = summary.body;
      expect(itineraryId).toBe(it.id);
      expect(totals).toEqual(full.body.budgetSummary);
    });

    const foreign = [
      ['PATCH', (f: ItineraryFixture) => `/api/activities/${f.activityId}`, { name: 'hacked' }],
      ['DELETE', (f: ItineraryFixture) => `/api/activities/${f.activityId}`, undefined],
      ['PATCH', (f: ItineraryFixture) => `/api/budgets/${f.budgetId}`, { amount: 1 }],
      ['DELETE', (f: ItineraryFixture) => `/api/budgets/${f.budgetId}`, undefined],
      ['PATCH', (f: ItineraryFixture) => `/api/transport-costs/${f.transportId}`, { amount: 1 }],
      ['DELETE', (f: ItineraryFixture) => `/api/transport-costs/${f.transportId}`, undefined],
    ] as const;
    it.each(foreign)("another user's id gives 404 and changes nothing: %s %#", async (method, path, body) => {
      const [owner, stranger] = [await createUser(ctx), await createUser(ctx)];
      const it = await newItinerary(owner);
      const before = normalize(await view(owner, it.id));
      const call = stranger.agent[method.toLowerCase() as 'patch' | 'delete'](path(it));
      const res = await (body ? call.send(body) : call);
      expect(res.status).toBe(404);
      expect(normalize(await view(owner, it.id))).toBe(before);
    });

    it("another user's itinerary budget-summary is 404", async () => {
      const [owner, stranger] = [await createUser(ctx), await createUser(ctx)];
      const it = await newItinerary(owner);
      expect((await stranger.agent.get(`/api/itineraries/${it.id}/budget-summary`)).status).toBe(404);
    });

    it.each([
      ['PATCH', '/api/activities/' + '1'.repeat(24)],
      ['DELETE', '/api/budgets/' + '1'.repeat(24)],
      ['PATCH', '/api/transport-costs/' + '1'.repeat(24)],
      ['GET', '/api/itineraries/' + '1'.repeat(24) + '/budget-summary'],
      ['PATCH', '/api/itineraries/' + '1'.repeat(24) + '/days/reorder'],
    ])('no cookie gives 401: %s %s', async (method, path) => {
      const res = await (ctx.http() as any)[method.toLowerCase()](path).send({});
      expect(res.status).toBe(401);
    });
  });

  // ---------- bookings, payments, refunds ----------
  describe('bookings, payments and refunds', () => {
    it('POST /hotel-bookings/:id/cancel returns the same as DELETE (unpaid hold)', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const [u1, u2] = [await createUser(ctx), await createUser(ctx)];
      const a = await holdHotel(u1, { hotelId, roomIds, checkIn: day(10), checkOut: day(13) });
      const b = await holdHotel(u2, { hotelId, roomIds, checkIn: day(20), checkOut: day(23) });
      const alias = await u1.agent.post(`/api/hotel-bookings/${a.body._id}/cancel`);
      const original = await u2.agent.delete(`/api/hotel-bookings/${b.body._id}`);
      expect(alias.status).toBe(200);
      expectSame(alias, original);
    });

    it('POST /hotel-bookings/:id/cancel returns the same as DELETE (confirmed, with refund)', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const [u1, u2] = [await createUser(ctx), await createUser(ctx)];
      const a = await holdHotel(u1, { hotelId, roomIds, checkIn: day(10), checkOut: day(13) });
      const b = await holdHotel(u2, { hotelId, roomIds, checkIn: day(20), checkOut: day(23) });
      await confirmBooking(ctx, u1, 'hotel', a.body._id);
      await confirmBooking(ctx, u2, 'hotel', b.body._id);
      const alias = await u1.agent.post(`/api/hotel-bookings/${a.body._id}/cancel`);
      const original = await u2.agent.delete(`/api/hotel-bookings/${b.body._id}`);
      expect(alias.status).toBe(200);
      expect(alias.body.refundPercentage).toBe(100);
      expectSame(alias, original);
    });

    it('POST /flight-bookings/:id/cancel returns the same as DELETE', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 4 });
      const [u1, u2] = [await createUser(ctx), await createUser(ctx)];
      const a = await holdFlight(u1, { flightId });
      const b = await holdFlight(u2, { flightId });
      const alias = await u1.agent.post(`/api/flight-bookings/${a.body._id}/cancel`);
      const original = await u2.agent.delete(`/api/flight-bookings/${b.body._id}`);
      expect(alias.status).toBe(200);
      expectSame(alias, original);
    });

    it('POST /flight-bookings/hold returns the same as POST /flight-bookings', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 4 });
      const [u1, u2] = [await createUser(ctx), await createUser(ctx)];
      const body = { flightId, cabinClass: 'Economy', passengers: [{ fullName: 'A B', dateOfBirth: '1990-01-01' }], policiesAccepted: true };
      const alias = await u1.agent.post('/api/flight-bookings/hold').send(body);
      const original = await u2.agent.post('/api/flight-bookings').send(body);
      expect(alias.status).toBe(201);
      expectSame(alias, original);
    });

    it("cancelling another user's booking through the alias is 404, like the original", async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 2 });
      const [owner, stranger] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdFlight(owner, { flightId });
      const alias = await stranger.agent.post(`/api/flight-bookings/${hold.body._id}/cancel`);
      const original = await stranger.agent.delete(`/api/flight-bookings/${hold.body._id}`);
      expect(alias.status).toBe(404);
      expect(original.status).toBe(404);
    });

    it('GET /refunds/:id is 404 while no refund exists and 200 once a confirmed booking is cancelled', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const [user, stranger] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdHotel(user, { hotelId, roomIds });
      const paymentId = await confirmBooking(ctx, user, 'hotel', hold.body._id);

      // paid, nothing refunded yet
      expect((await user.agent.get(`/api/payments/${paymentId}`)).body.refundId).toBeNull();

      const cancel = await user.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`);
      expect(cancel.status).toBe(200);
      // PAY-03: the refund is its own record with its own id (not the payment id).
      const refundId = cancel.body.refundId;
      expect(refundId).toEqual(expect.any(String));
      expect(refundId).not.toBe(paymentId);
      expect((await user.agent.get(`/api/payments/${paymentId}`)).body.refundId).toBe(refundId);

      const refund = await user.agent.get(`/api/refunds/${refundId}`);
      expect(refund.status).toBe(200);
      expect(refund.body.paymentId).toBe(paymentId);
      expect(ctx.stripe.refunds.some((r) => r.paymentId === paymentId)).toBe(true);
      // a payment id is not a refund id
      expect((await user.agent.get(`/api/refunds/${paymentId}`)).status).toBe(404);

      expect((await stranger.agent.get(`/api/refunds/${refundId}`)).status).toBe(404);
      expect((await ctx.http().get(`/api/refunds/${refundId}`)).status).toBe(401);
    });

    it('GET /refunds/:id is 404 for an unpaid hold released as Expired (no refund id)', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const hold = await holdHotel(user, { hotelId, roomIds });
      const pay = await startPayment(user, 'hotel', hold.body._id);
      const cancel = await user.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`);
      expect(cancel.body.refundId).toBeNull();
      expect((await user.agent.get(`/api/refunds/${pay.body.paymentId}`)).status).toBe(404);
    });

    it.each(['/api/payments/webhook', '/api/stripe/webhook'])('webhook %s with a bad signature gives 400 and changes nothing', async (path) => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const hold = await holdHotel(user, { hotelId, roomIds });
      const res = await ctx.http().post(path).set('stripe-signature', 'forged').set('content-type', 'application/json').send(JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: {} } }));
      expect(res.status).toBe(400);
      expect((await user.agent.get(`/api/hotel-bookings/${hold.body._id}`)).body.status).toBe('Pending Payment');
    });

    it.each(['/api/payments/webhook', '/api/stripe/webhook'])('webhook %s without a signature header gives 400', async (path) => {
      const res = await ctx.http().post(path).set('content-type', 'application/json').send('{}');
      expect(res.status).toBe(400);
    });

    it.each(['/api/payments/webhook', '/api/stripe/webhook'])('webhook %s accepts a valid signature without a login (public route)', async (path) => {
      const res = await ctx.http().post(path).set('stripe-signature', StripeFake.VALID_SIGNATURE).set('content-type', 'application/json')
        .send(JSON.stringify({ id: `evt_${path}`, type: 'customer.created', data: { object: {} } }));
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ received: true });
    });
  });

  // ---------- hotels ----------
  describe('hotels', () => {
    const policies = { checkInTime: '14:00', checkOutTime: '12:00', cancellationTiers: [{ daysBeforeCheckIn: 5, refundPercentage: 50 }, { daysBeforeCheckIn: 0, refundPercentage: 0 }] };

    it('PUT /hotels/:id/policies returns the same as PATCH /hotels/:id', async () => {
      const [h1, h2] = [await createHotelWithRooms(ctx, { rooms: 1 }), await createHotelWithRooms(ctx, { rooms: 1 })];
      const alias = await h1.moderator.agent.put(`/api/hotels/${h1.hotelId}/policies`).send(policies);
      const original = await h2.moderator.agent.patch(`/api/hotels/${h2.hotelId}`).send(policies);
      expect(alias.status).toBe(200);
      expect(original.status).toBe(200);
      const strip = (b: any) => ({ ...b, name: undefined, address: undefined });
      expect(normalize(strip(alias.body))).toBe(normalize(strip(original.body)));
      expect(alias.body.checkInTime).toBe('14:00');
    });

    it('PUT /hotels/:id/policies rejects fields outside the policy (400) and changes nothing', async () => {
      const h = await createHotelWithRooms(ctx, { rooms: 1 });
      const res = await h.moderator.agent.put(`/api/hotels/${h.hotelId}/policies`).send({ ...policies, name: 'Renamed' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/name/);
      const stored: any = await ctx.conn.model('Hotel').findById(h.hotelId).lean();
      expect(stored.name).not.toBe('Renamed');
      expect(stored.checkInTime).toBe('15:00');
    });

    it('PUT /hotels/:id/policies: customer 403, anonymous 401, another hotel\'s moderator 403', async () => {
      const [h1, h2] = [await createHotelWithRooms(ctx, { rooms: 1 }), await createHotelWithRooms(ctx, { rooms: 1 })];
      const customer = await createUser(ctx);
      expect((await customer.agent.put(`/api/hotels/${h1.hotelId}/policies`).send(policies)).status).toBe(403);
      expect((await ctx.http().put(`/api/hotels/${h1.hotelId}/policies`).send(policies)).status).toBe(401);
      const wrongHotel = await h2.moderator.agent.put(`/api/hotels/${h1.hotelId}/policies`).send(policies);
      const wrongHotelOriginal = await h2.moderator.agent.patch(`/api/hotels/${h1.hotelId}`).send(policies);
      expect(wrongHotel.status).toBeGreaterThanOrEqual(403);
      expect(wrongHotel.status).toBe(wrongHotelOriginal.status);
    });

    const range = () => `startDate=${day(10)}&endDate=${day(14)}`;

    it('GET /hotels/:id/availability returns the same as /rooms/status', async () => {
      const h = await createHotelWithRooms(ctx, { rooms: 3 });
      const guest = await createUser(ctx);
      await holdHotel(guest, { hotelId: h.hotelId, roomIds: [h.roomIds[0]], checkIn: day(11), checkOut: day(12) });
      const alias = await h.moderator.agent.get(`/api/hotels/${h.hotelId}/availability?${range()}`);
      const original = await h.moderator.agent.get(`/api/hotels/${h.hotelId}/rooms/status?${range()}`);
      expect(alias.status).toBe(200);
      expectSame(alias, original);
      expect(JSON.stringify(alias.body)).toContain(h.roomIds[0]);
    });

    it('GET /hotels/:id/availability is moderator-only: customer 403, admin 403, anonymous 401, other hotel 403, same as /rooms/status', async () => {
      const [h1, h2] = [await createHotelWithRooms(ctx, { rooms: 1 }), await createHotelWithRooms(ctx, { rooms: 1 })];
      const customer = await createUser(ctx);
      const results: [string, any, any][] = [
        ['customer', customer.agent, 403],
        ['admin', h1.admin.agent, 403],
        ['other hotel moderator', h2.moderator.agent, 403],
      ];
      for (const [who, agent, status] of results) {
        const alias = await agent.get(`/api/hotels/${h1.hotelId}/availability?${range()}`);
        const original = await agent.get(`/api/hotels/${h1.hotelId}/rooms/status?${range()}`);
        expect([who, alias.status]).toEqual([who, status]);
        expect([who, original.status]).toEqual([who, status]);
      }
      expect((await ctx.http().get(`/api/hotels/${h1.hotelId}/availability?${range()}`)).status).toBe(401);
    });

    it('GET /hotels/:id/availability needs a valid date range (400)', async () => {
      const h = await createHotelWithRooms(ctx, { rooms: 1 });
      expect((await h.moderator.agent.get(`/api/hotels/${h.hotelId}/availability`)).status).toBe(400);
      expect((await h.moderator.agent.get(`/api/hotels/${h.hotelId}/availability?startDate=${day(14)}&endDate=${day(10)}`)).status).toBe(400);
    });
  });

  // ---------- documentation ----------
  describe('Swagger', () => {
    const routes: [string, string][] = [
      ['post', '/api/flight-bookings/{id}/cancel'], ['post', '/api/hotel-bookings/{id}/cancel'], ['post', '/api/flight-bookings/hold'],
      ['patch', '/api/itineraries/{id}/days/reorder'], ['post', '/api/payments/webhook'],
      ['patch', '/api/activities/{id}'], ['delete', '/api/activities/{id}'], ['patch', '/api/budgets/{id}'], ['delete', '/api/budgets/{id}'],
      ['post', '/api/itineraries/{id}/days/{dayId}/budgets'], ['patch', '/api/transport-costs/{id}'], ['delete', '/api/transport-costs/{id}'],
      ['get', '/api/itineraries/{id}/budget-summary'], ['get', '/api/refunds/{id}'],
      ['put', '/api/hotels/{hotelId}/policies'], ['get', '/api/hotels/{hotelId}/availability'], ['patch', '/api/auth/change-password'],
    ];

    it('the Swagger JSON lists every PDF route', () => {
      const paths = ctx.swaggerDocument!.paths;
      const missing = routes.filter(([method, path]) => !paths[path]?.[method]).map(([m, p]) => `${m.toUpperCase()} ${p}`);
      expect(missing).toEqual([]);
    });

    it('legacy routes are still listed, described as legacy aliases and not flagged deprecated', () => {
      const paths = ctx.swaggerDocument!.paths as Record<string, Record<string, any>>;
      for (const [method, path] of [['patch', '/api/itineraries/{id}/days/order'], ['delete', '/api/flight-bookings/{id}'], ['get', '/api/hotels/{hotelId}/rooms/status'], ['post', '/api/stripe/webhook']] as const) {
        const op = paths[path]?.[method];
        expect(op).toBeDefined();
        expect(op.description).toMatch(/legacy alias/i);
        expect(op.deprecated).toBeUndefined();
      }
    });

    it('both flight hold routes carry the "creating the booking IS the hold" warning', () => {
      const paths = ctx.swaggerDocument!.paths as Record<string, Record<string, any>>;
      expect(paths['/api/flight-bookings/hold'].post.description).toMatch(/IS the hold/);
      expect(paths['/api/flight-bookings'].post.description).toMatch(/IS the hold/);
    });
  });
});
