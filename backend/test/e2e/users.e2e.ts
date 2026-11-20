import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdFlight, holdHotel } from './helpers/bookings';
import { createAirlineWithFlight, createHotelWithRooms, createUser, day } from './helpers/factories';
import { seedReference } from './helpers/reference';

describe('user profile and account deletion (ACC-09, ACC-12)', () => {
  let ctx: E2EContext;
  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  it('a new account prefers the platform currency', async () => {
    const user = await createUser(ctx);
    const platform = (process.env.PLATFORM_CURRENCY || 'USD').toUpperCase();
    expect((await user.agent.get('/api/users/me')).body.user.preferredCurrency).toBe(platform);
  });

  describe('PATCH /users/me', () => {
    it('updates name, phone and a supported preferred currency', async () => {
      const user = await createUser(ctx);
      const res = await user.agent.patch('/api/users/me').send({ name: 'New Name', phone: '+201001234567', preferredCurrency: 'USD' });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ name: 'New Name', preferredCurrency: 'USD' });
      expect((await user.agent.get('/api/users/me')).body.user.preferredCurrency).toBe('USD');
    });

    it.each([['unsupported code', 'CAD'], ['wrong length', 'US'], ['not letters', '12$']])('an invalid currency is rejected (400): %s', async (_n, preferredCurrency) => {
      const user = await createUser(ctx);
      const res = await user.agent.patch('/api/users/me').send({ preferredCurrency });
      expect(res.status).toBe(400);
      expect((await user.agent.get('/api/users/me')).body.user.preferredCurrency).not.toBe(preferredCurrency);
    });

    it.each([['role', 'admin'], ['email', 'x@e2e.test'], ['isSuspended', false], ['password', 'Hack3d!pass']])('restricted field %s cannot be edited (400)', async (field, value) => {
      const user = await createUser(ctx);
      const res = await user.agent.patch('/api/users/me').send({ [field]: value });
      expect(res.status).toBe(400);
      const stored: any = await ctx.conn.model('User').findById(user.id).lean();
      expect(stored.role).toBe('user');
      expect(stored.email).toBe(user.email);
    });

    it('needs a login (401)', async () => {
      expect((await ctx.http().patch('/api/users/me').send({ name: 'x' })).status).toBe(401);
    });
  });

  describe('DELETE /users/me', () => {
    it.each([['no body', undefined], ['confirm false', { confirm: false }], ['the string "true"', { confirm: 'true' }], ['the string "false"', { confirm: 'false' }]])('is rejected without a real confirm (400): %s', async (_n, body) => {
      const user = await createUser(ctx);
      const call = user.agent.delete('/api/users/me');
      const res = await (body ? call.send(body) : call);
      expect(res.status).toBe(400);
      expect((await user.agent.get('/api/users/me')).status).toBe(200);
    });

    it('is blocked by an upcoming Confirmed hotel booking (409)', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const user = await createUser(ctx);
      const hold = await holdHotel(user, { hotelId, roomIds });
      await confirmBooking(ctx, user, 'hotel', hold.body._id);
      const res = await user.agent.delete('/api/users/me').send({ confirm: true });
      expect(res.status).toBe(409);
      expect((await user.agent.get('/api/users/me')).status).toBe(200);
    });

    it('is blocked by an upcoming Confirmed flight booking (409)', async () => {
      const { flightId } = await createAirlineWithFlight(ctx);
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      await confirmBooking(ctx, user, 'flight', hold.body._id);
      expect((await user.agent.delete('/api/users/me').send({ confirm: true })).status).toBe(409);
    });

    it('is NOT blocked by an unpaid hold or a cancelled booking', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 2 });
      const user = await createUser(ctx);
      await holdHotel(user, { hotelId, roomIds: [roomIds[0]] });
      const paid = await holdHotel(user, { hotelId, roomIds: [roomIds[1]] });
      await confirmBooking(ctx, user, 'hotel', paid.body._id);
      await user.agent.post(`/api/hotel-bookings/${paid.body._id}/cancel`);
      expect((await user.agent.delete('/api/users/me').send({ confirm: true })).status).toBe(200);
    });

    it('succeeds: ends the session, blocks login, hides posts, makes itineraries private and shows "Deleted user"', async () => {
      const leaver = await createUser(ctx, 'user', { name: 'Leaving Lara' });
      const reader = await createUser(ctx);

      // content owned by the leaver
      const post = await leaver.agent.post('/api/posts').send({ title: 'My trip', body: 'It was great', tags: ['egypt'], status: 'published' });
      expect(post.status).toBe(201);
      const postId = post.body._id ?? post.body.id;
      const itinerary = await leaver.agent.post('/api/itineraries').send({ title: 'Public plan', countryIds: ['EG'], startDate: day(20), endDate: day(25), visibility: 'public' });
      const itineraryId = itinerary.body._id ?? itinerary.body.id;
      // a comment by the leaver on someone else's post
      const other = await reader.agent.post('/api/posts').send({ title: 'Other', body: 'Other post', status: 'published' });
      const otherId = other.body._id ?? other.body.id;
      expect((await leaver.agent.post(`/api/posts/${otherId}/comments`).send({ body: 'Nice one' })).status).toBe(201);

      expect((await ctx.http().get(`/api/posts/${postId}`)).status).toBe(200);
      expect(JSON.stringify((await ctx.http().get(`/api/posts/${postId}`)).body)).toContain('Leaving Lara');

      const del = await leaver.agent.delete('/api/users/me').send({ confirm: true });
      expect(del.status).toBe(200);

      // session ended and login blocked with the generic message
      expect((await leaver.agent.get('/api/auth/me')).status).toBe(401);
      const relogin = await ctx.http().post('/api/auth/login').send({ email: leaver.email, password: leaver.password });
      expect(relogin.status).toBe(401);
      expect(relogin.body.message).toBe('Invalid email or password');

      // posts hidden with the moderation status
      expect((await ctx.http().get(`/api/posts/${postId}`)).status).toBe(404);
      const stored: any = await ctx.conn.model('Post').findById(postId).lean();
      expect(stored.status).toBe('hidden');
      expect(JSON.stringify((await ctx.http().get('/api/posts')).body)).not.toContain(postId);

      // itineraries private
      const storedItinerary: any = await ctx.conn.model('Itinerary').findById(itineraryId).lean();
      expect(storedItinerary.visibility).toBe('private');

      // remaining content is attributed to "Deleted user", never the real name
      const comments = JSON.stringify((await ctx.http().get(`/api/posts/${otherId}/comments`)).body);
      expect(comments).toContain('Deleted user');
      expect(comments).not.toContain('Leaving Lara');
    });

    it('the deleted account shows as deactivated to an admin and its email stays reserved', async () => {
      const admin = await createUser(ctx, 'admin');
      const user = await createUser(ctx);
      await user.agent.delete('/api/users/me').send({ confirm: true });
      const list = await admin.agent.get(`/api/admin/accounts?search=${encodeURIComponent(user.email)}`);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].status).toBe('deactivated');
      const again = await ctx.http().post('/api/auth/register').send({ name: 'Again', email: user.email, password: user.password, acceptTerms: true });
      expect(again.status).toBe(409);
    });

    it('needs a login (401)', async () => {
      expect((await ctx.http().delete('/api/users/me').send({ confirm: true })).status).toBe(401);
    });
  });
});
