import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdFlight, holdHotel } from './helpers/bookings';
import { createAirlineWithFlight, createHotelWithRooms, createUser, day, unique, type TestUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

describe('administration (ACC-14, ACC-15, ACC-16, ACC-17)', () => {
  let ctx: E2EContext;
  let admin: TestUser;
  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
    admin = await createUser(ctx, 'admin');
  });
  afterAll(() => ctx.close());

  describe('accounts listing', () => {
    it('defaults to 10 per page and pages through the rest', async () => {
      const tag = unique('page');
      for (let i = 0; i < 12; i++) await createUser(ctx, 'user', { name: `${tag} person ${i}`, email: `${tag}-${i}@e2e.test` });
      const first = await admin.agent.get(`/api/admin/accounts?search=${tag}`);
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(10);
      expect(first.body).toMatchObject({ page: 1, limit: 10, total: 12, pages: 2 });
      const second = await admin.agent.get(`/api/admin/accounts?search=${tag}&page=2`);
      expect(second.body.items).toHaveLength(2);
      const ids = [...first.body.items, ...second.body.items].map((i: any) => i.id);
      expect(new Set(ids).size).toBe(12);
    });

    it('filters by role, status and search together', async () => {
      const tag = unique('flt');
      const active = await createUser(ctx, 'user', { name: `${tag} active`, email: `${tag}-a@e2e.test` });
      const suspended = await createUser(ctx, 'user', { name: `${tag} suspended`, email: `${tag}-s@e2e.test` });
      const gone = await createUser(ctx, 'user', { name: `${tag} gone`, email: `${tag}-g@e2e.test` });
      await createUser(ctx, 'moderator', { name: `${tag} mod`, email: `${tag}-m@e2e.test` });
      await admin.agent.patch(`/api/admin/accounts/${suspended.id}/suspend`);
      await gone.agent.delete('/api/users/me').send({ confirm: true });

      const get = async (query: string) => (await admin.agent.get(`/api/admin/accounts?search=${tag}&${query}`)).body.items.map((i: any) => i.id).sort();
      expect(await get('role=user&status=active')).toEqual([active.id]);
      expect(await get('role=user&status=suspended')).toEqual([suspended.id]);
      expect(await get('role=user&status=deactivated')).toEqual([gone.id]);
      expect(await get('role=moderator')).toHaveLength(1);
      expect(await get('role=user')).toHaveLength(3);
      expect(await get('')).toHaveLength(4);
      expect(await get('role=moderator&status=suspended')).toEqual([]);
      const narrowed = await admin.agent.get(`/api/admin/accounts?search=${tag}%20suspended&role=user`);
      expect(narrowed.body.items.map((i: any) => i.id)).toEqual([suspended.id]);
    });

    it('rows carry name, email, role, status and registration date, and no secrets', async () => {
      const res = await admin.agent.get('/api/admin/accounts?limit=1');
      expect(Object.keys(res.body.items[0]).sort()).toEqual(['email', 'id', 'name', 'registeredAt', 'role', 'status']);
    });

    it('is admin-only: customer and moderator get 403, anonymous 401', async () => {
      const [customer, moderator] = [await createUser(ctx), await createUser(ctx, 'moderator')];
      expect((await customer.agent.get('/api/admin/accounts')).status).toBe(403);
      expect((await moderator.agent.get('/api/admin/accounts')).status).toBe(403);
      expect((await ctx.http().get('/api/admin/accounts')).status).toBe(401);
    });

    it('an invalid role or status filter is rejected (400)', async () => {
      expect((await admin.agent.get('/api/admin/accounts?role=king')).status).toBe(400);
      expect((await admin.agent.get('/api/admin/accounts?status=asleep')).status).toBe(400);
    });
  });

  describe('moderator creation', () => {
    it('creates a hotel moderator for an active hotel; the moderator must change the temporary password', async () => {
      const { hotelId } = await createHotelWithRooms(ctx, { rooms: 0 });
      const email = `${unique('hm')}@e2e.test`;
      const res = await admin.agent.post('/api/admin/moderators').send({ name: 'Hotel Mod', email, providerType: 'hotel', providerId: hotelId });
      expect(res.status).toBe(201);
      expect(res.body.account).toMatchObject({ email, role: 'moderator' });
      const stored: any = await ctx.conn.model('User').findOne({ email }).lean();
      expect(stored).toMatchObject({ hotelId, mustChangePassword: true });
      expect(stored.airlineId ?? null).toBeNull();
    });

    it('creates an airline moderator for an active airline', async () => {
      const { airlineId } = await createAirlineWithFlight(ctx);
      const email = `${unique('am')}@e2e.test`;
      const res = await admin.agent.post('/api/admin/moderators').send({ name: 'Airline Mod', email, providerType: 'airline', providerId: airlineId });
      expect(res.status).toBe(201);
      expect((await ctx.conn.model('User').findOne({ email }).lean() as any).airlineId).toBe(airlineId);
    });

    it('rejects an inactive provider (409), then accepts it once reactivated', async () => {
      const { hotelId } = await createHotelWithRooms(ctx, { rooms: 0 });
      expect((await admin.agent.patch(`/api/admin/providers/hotel/${hotelId}/deactivate`)).status).toBe(200);
      const email = `${unique('hm')}@e2e.test`;
      const body = { name: 'Late Mod', email, providerType: 'hotel', providerId: hotelId };
      expect((await admin.agent.post('/api/admin/moderators').send(body)).status).toBe(409);
      expect(await ctx.conn.model('User').exists({ email })).toBeNull();
      expect((await admin.agent.patch(`/api/admin/providers/hotel/${hotelId}/reactivate`)).status).toBe(200);
      expect((await admin.agent.post('/api/admin/moderators').send(body)).status).toBe(201);
    });

    it.each([
      ['unknown provider id', { providerType: 'hotel', providerId: '1'.repeat(24) }, 404],
      ['malformed provider id', { providerType: 'hotel', providerId: 'nope' }, 400],
      ['bad provider type', { providerType: 'Hotel', providerId: '1'.repeat(24) }, 400],
    ])('is rejected for %s', async (_n, extra, status) => {
      const res = await admin.agent.post('/api/admin/moderators').send({ name: 'X', email: `${unique('x')}@e2e.test`, ...extra });
      expect(res.status).toBe(status);
    });

    it('a duplicate email is 409', async () => {
      const { hotelId } = await createHotelWithRooms(ctx, { rooms: 0 });
      const taken = await createUser(ctx);
      const res = await admin.agent.post('/api/admin/moderators').send({ name: 'Dup', email: taken.email, providerType: 'hotel', providerId: hotelId });
      expect(res.status).toBe(409);
    });

    it('is admin-only: a moderator cannot create moderators (403)', async () => {
      const { hotelId, moderator } = await createHotelWithRooms(ctx, { rooms: 0 });
      const res = await moderator.agent.post('/api/admin/moderators').send({ name: 'X', email: `${unique('x')}@e2e.test`, providerType: 'hotel', providerId: hotelId });
      expect(res.status).toBe(403);
    });
  });

  describe('suspend and reactivate', () => {
    it('suspending revokes the session and blocks login; reactivating restores access', async () => {
      const user = await createUser(ctx);
      expect((await user.agent.get('/api/auth/me')).status).toBe(200);
      expect((await admin.agent.patch(`/api/admin/accounts/${user.id}/suspend`)).status).toBe(200);
      expect((await user.agent.get('/api/auth/me')).status).toBe(401);
      expect((await ctx.http().post('/api/auth/login').send({ email: user.email, password: user.password })).status).toBe(403);
      expect((await admin.agent.get(`/api/admin/accounts/${user.id}`)).body.isSuspended).toBe(true);

      expect((await admin.agent.patch(`/api/admin/accounts/${user.id}/reactivate`)).status).toBe(200);
      expect((await ctx.http().post('/api/auth/login').send({ email: user.email, password: user.password })).status).toBe(201);
    });

    it('an admin cannot be suspended, and unknown ids are 404 / malformed 400', async () => {
      const other = await createUser(ctx, 'admin');
      expect((await admin.agent.patch(`/api/admin/accounts/${other.id}/suspend`)).status).toBeGreaterThanOrEqual(400);
      expect((await admin.agent.patch(`/api/admin/accounts/${'1'.repeat(24)}/suspend`)).status).toBe(404);
      expect((await admin.agent.patch('/api/admin/accounts/nope/suspend')).status).toBe(400);
    });

    it('GET /admin/accounts/:id never exposes credentials', async () => {
      const user = await createUser(ctx);
      const res = await admin.agent.get(`/api/admin/accounts/${user.id}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('refreshTokenHash');
    });
  });

  describe('provider deactivation', () => {
    it('notifies users with upcoming bookings, and only them', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 2 });
      const [booked, bystander] = [await createUser(ctx), await createUser(ctx)];
      const hold = await holdHotel(booked, { hotelId, roomIds: [roomIds[0]] });
      await confirmBooking(ctx, booked, 'hotel', hold.body._id);

      const res = await admin.agent.patch(`/api/admin/providers/hotel/${hotelId}/deactivate`);
      expect(res.status).toBe(200);
      expect(res.body.provider).toEqual({ id: hotelId, isActive: false });

      const mine = await booked.agent.get('/api/notifications');
      expect(mine.status).toBe(200);
      // GEN-01: the inbox now also holds the "booking confirmed" notification; exactly one is about the provider.
      expect(mine.body.items.filter((n: any) => n.title === 'Travel provider unavailable')).toHaveLength(1);
      expect(mine.body.items[0]).toMatchObject({ title: 'Travel provider unavailable', resourceType: 'hotel', resourceId: hotelId, isRead: false });
      expect((await bystander.agent.get('/api/notifications')).body.total).toBe(0);
      // the existing booking stays on file
      expect((await booked.agent.get(`/api/hotel-bookings/${hold.body._id}`)).body.status).toBe('Confirmed');
    });

    it('notifies flight passengers when an airline is deactivated', async () => {
      const { airlineId, flightId } = await createAirlineWithFlight(ctx, { seats: 3 });
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      await confirmBooking(ctx, user, 'flight', hold.body._id);
      expect((await admin.agent.patch(`/api/admin/providers/airline/${airlineId}/deactivate`)).status).toBe(200);
      expect((await user.agent.get('/api/notifications')).body.items[0]).toMatchObject({ resourceType: 'airline', resourceId: airlineId });
    });

    it('a deactivated hotel takes no new holds, and deactivating twice is 409', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      await admin.agent.patch(`/api/admin/providers/hotel/${hotelId}/deactivate`);
      expect((await admin.agent.patch(`/api/admin/providers/hotel/${hotelId}/deactivate`)).status).toBe(409);
      expect((await holdHotel(await createUser(ctx), { hotelId, roomIds })).status).toBeGreaterThanOrEqual(400);
    });

    it('a customer cannot deactivate providers (403)', async () => {
      const { hotelId } = await createHotelWithRooms(ctx, { rooms: 0 });
      expect(((await (await createUser(ctx)).agent.patch(`/api/admin/providers/hotel/${hotelId}/deactivate`))).status).toBe(403);
    });
  });

  describe('GET /admin/bookings', () => {
    let alice: TestUser, bob: TestUser, hotelBooking: string, hotelBooking2: string, flightBooking: string;

    beforeAll(async () => {
      const [h, f] = [await createHotelWithRooms(ctx, { rooms: 2 }), await createAirlineWithFlight(ctx, { seats: 5, departInDays: 40 })];
      [alice, bob] = [await createUser(ctx), await createUser(ctx)];
      hotelBooking = (await holdHotel(alice, { hotelId: h.hotelId, roomIds: [h.roomIds[0]], checkIn: day(10), checkOut: day(12) })).body._id;
      hotelBooking2 = (await holdHotel(bob, { hotelId: h.hotelId, roomIds: [h.roomIds[1]], checkIn: day(60), checkOut: day(62) })).body._id;
      flightBooking = (await holdFlight(alice, { flightId: f.flightId })).body._id;
      await confirmBooking(ctx, alice, 'hotel', hotelBooking);
      // push the second hotel booking's creation date into the past
      await ctx.conn.model('HotelBooking').collection.updateOne({ _id: new (await import('mongoose')).Types.ObjectId(hotelBooking2) }, { $set: { createdAt: new Date(`${day(-30)}T12:00:00.000Z`) } });
    });

    const ids = async (query: string) => (await admin.agent.get(`/api/admin/bookings?${query}`)).body.items.map((i: any) => i.id);

    it('lists flight and hotel bookings with user, provider, amount and status', async () => {
      const res = await admin.agent.get(`/api/admin/bookings?userId=${alice.id}`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: any) => i.id).sort()).toEqual([hotelBooking, flightBooking].sort());
      const hotel = res.body.items.find((i: any) => i.id === hotelBooking);
      expect(hotel).toMatchObject({ type: 'hotel', status: 'Confirmed', user: { id: alice.id, email: alice.email }, amount: { currency: 'EGP' } });
      expect(hotel.provider.name).toEqual(expect.any(String));
      expect(res.body.countsByType).toEqual({ flight: 1, hotel: 1 });
    });

    it('filters by type, status and user', async () => {
      expect(await ids(`userId=${alice.id}&type=flight`)).toEqual([flightBooking]);
      expect(await ids(`userId=${alice.id}&status=Confirmed`)).toEqual([hotelBooking]);
      expect(await ids(`userId=${bob.id}`)).toEqual([hotelBooking2]);
      expect(await ids(`userId=${bob.id}&status=Cancelled`)).toEqual([]);
    });

    it('from/to default to the travel start date (check-in / departure)', async () => {
      expect(await ids(`userId=${alice.id}&type=hotel&from=${day(9)}&to=${day(11)}`)).toEqual([hotelBooking]);
      expect(await ids(`userId=${alice.id}&type=hotel&from=${day(20)}&to=${day(30)}`)).toEqual([]);
      expect(await ids(`userId=${bob.id}&from=${day(59)}&to=${day(61)}`)).toEqual([hotelBooking2]);
      expect(await ids(`userId=${alice.id}&type=flight&from=${day(39)}&to=${day(41)}`)).toEqual([flightBooking]);
    });

    it('dateField=booked filters on the booking creation date instead', async () => {
      // bob's booking was created 30 days ago but is for a stay in 60 days
      expect(await ids(`userId=${bob.id}&dateField=booked&from=${day(-31)}&to=${day(-29)}`)).toEqual([hotelBooking2]);
      expect(await ids(`userId=${bob.id}&dateField=booked&from=${day(-1)}&to=${day(1)}`)).toEqual([]);
      expect(await ids(`userId=${bob.id}&dateField=travel&from=${day(-31)}&to=${day(-29)}`)).toEqual([]);
      // alice's bookings were made today
      expect((await ids(`userId=${alice.id}&dateField=booked&from=${day(0)}&to=${day(0)}`)).sort()).toEqual([hotelBooking, flightBooking].sort());
    });

    it('rejects a bad date range, unknown dateField, unknown status and unknown type (400)', async () => {
      expect((await admin.agent.get(`/api/admin/bookings?from=${day(5)}&to=${day(1)}`)).status).toBe(400);
      expect((await admin.agent.get('/api/admin/bookings?dateField=never')).status).toBe(400);
      for (const query of ['status=Maybe', 'status=confirmed', 'type=train', 'type=Hotel']) {
        const res = await admin.agent.get(`/api/admin/bookings?${query}`);
        expect([query, res.status]).toEqual([query, 400]);
        expect(res.body.errors[0].field).toBe(query.split('=')[0]);
      }
    });

    it.each(['Pending Payment', 'Confirmed', 'Completed', 'Expired', 'Cancelled'])('the real status "%s" is accepted', async (status) => {
      expect((await admin.agent.get(`/api/admin/bookings?status=${encodeURIComponent(status)}`)).status).toBe(200);
    });

    it('paginates 10 at a time by default', async () => {
      const res = await admin.agent.get('/api/admin/bookings');
      expect(res.body.limit).toBe(10);
      expect(res.body.items.length).toBeLessThanOrEqual(10);
    });

    it('is admin-only (customer 403, anonymous 401)', async () => {
      expect((await alice.agent.get('/api/admin/bookings')).status).toBe(403);
      expect((await ctx.http().get('/api/admin/bookings')).status).toBe(401);
    });
  });
});
