import { Types } from 'mongoose';

import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdFlight, holdHotel } from './helpers/bookings';
import { createAirlineWithFlight, createHotelWithRooms, createUser, day, type TestUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

/** Provider views (FLT-29, HTL-22), reviews (HTL-23, HTL-24), grouped booking lists (FLT-25, HTL-20), e-ticket alias (FLT-23), page size (GEN-05). */
describe('provider views, reviews, grouped lists and page sizes (FLT-29, HTL-22, HTL-23, HTL-24, FLT-25, HTL-20, FLT-23, GEN-05)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  const model = (name: string) => ctx.conn.model(name);

  describe('page size 10 by default, limit up to 100 (GEN-05)', () => {
    let admin: TestUser;
    let author: TestUser;
    let postId: string;
    const TAG = 'pagesizetag';

    beforeAll(async () => {
      admin = await createUser(ctx, 'admin');
      author = await createUser(ctx);
      const now = Date.now();
      const posts = await model('Post').insertMany(
        Array.from({ length: 12 }, (_, i) => ({ authorId: author.id, title: `Post ${i}`, body: 'Body', tags: [TAG], status: 'published', publishedAt: new Date(now - i * 1000) })),
      );
      postId = String(posts[0]._id);
      await model('Comment').insertMany(Array.from({ length: 12 }, (_, i) => ({ postId, authorId: author.id, body: `Comment ${i}`, status: 'visible' })));
      await model('Report').insertMany(posts.map((post) => ({ reporterId: author.id, targetType: 'post', targetId: post._id, reason: 'spam' })));
      await model('AuditLog').insertMany(Array.from({ length: 12 }, () => ({ actorId: admin.id, action: 'test.action', targetType: 'user', targetId: new Types.ObjectId() })));
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 20 });
      for (let i = 0; i < 12; i++) {
        await holdHotel(author, { hotelId, roomIds, checkIn: day(10 + 2 * i), checkOut: day(11 + 2 * i) });
        await holdFlight(author, { flightId });
      }
    });

    /** Each list and how to read its items and limit from the response. */
    const lists: [string, () => TestUser, (body: any) => { items: unknown[]; limit: number }][] = [
      ['/api/admin/audit-logs', () => admin, (b) => b],
      ['/api/admin/reports', () => admin, (b) => b],
      ['/api/posts', () => author, (b) => b],
      ['/api/posts/mine', () => author, (b) => b],
      [`/api/tags/${TAG}/posts`, () => author, (b) => b],
      ['/api/authors/:author', () => author, (b) => b.posts],
      ['/api/posts/:post/comments', () => author, (b) => b],
      ['/api/flight-bookings', () => author, (b) => ({ items: b.items, limit: b.pagination.limit })],
      ['/api/hotel-bookings', () => author, (b) => ({ items: b.items, limit: b.pagination.limit })],
    ];
    const url = (path: string) => path.replace(':author', author.id).replace(':post', postId);

    it.each(lists)('%s returns 10 by default, accepts limit=100 and rejects limit=101, 0 and page=0', async (path, who, read) => {
      const agent = who().agent;
      const first = await agent.get(url(path));
      expect(first.status).toBe(200);
      expect(read(first.body).limit).toBe(10);
      expect(read(first.body).items).toHaveLength(10);
      const all = await agent.get(`${url(path)}?limit=100`);
      expect(all.status).toBe(200);
      expect(read(all.body).items.length).toBeGreaterThanOrEqual(12);
      for (const bad of ['limit=101', 'limit=0', 'limit=ten', 'page=0']) {
        expect((await agent.get(`${url(path)}?${bad}`)).status).toBe(400);
      }
    });
  });
  describe('grouped booking lists (FLT-25, HTL-20)', () => {
    const ago = (ms: number) => new Date(Date.now() - ms);
    const ids = (res: any) => res.body.items.map((b: any) => String(b._id)).sort();

    it('flight bookings: upcoming, past and cancelled hold exactly the right bookings (own only)', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 20 });
      const user = await createUser(ctx);
      const other = await createUser(ctx);
      const make = async () => String((await holdFlight(user, { flightId })).body._id);
      const confirmed = await make();
      await confirmBooking(ctx, user, 'flight', confirmed);
      const live = await make();
      const lapsed = await make();
      const expired = await make();
      const cancelled = await make();
      const completed = await make();
      const departed = await make();
      const fb = model('FlightBooking');
      await fb.updateOne({ _id: lapsed }, { $set: { holdExpiresAt: ago(1000) } });
      await fb.updateOne({ _id: expired }, { $set: { status: 'Expired' } });
      await fb.updateOne({ _id: cancelled }, { $set: { status: 'Cancelled' } });
      await fb.updateOne({ _id: completed }, { $set: { status: 'Completed' } });
      await fb.updateOne({ _id: departed }, { $set: { status: 'Confirmed', departureTime: ago(60_000) } });
      await holdFlight(other, { flightId });

      const list = (q: string) => user.agent.get(`/api/flight-bookings?limit=100${q}`);
      expect(ids(await list('&group=upcoming'))).toEqual([confirmed, live].sort());
      expect(ids(await list('&group=past'))).toEqual([completed, departed].sort());
      expect(ids(await list('&group=cancelled'))).toEqual([lapsed, expired, cancelled].sort());
      expect((await list('')).body.items).toHaveLength(7);
      expect((await user.agent.get('/api/flight-bookings?group=soon')).status).toBe(400);
      expect((await ctx.http().get('/api/flight-bookings?group=upcoming')).status).toBe(401);
    });

    it('hotel bookings: a stay in progress is upcoming; a stay whose check-out day is over is past', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 6 });
      const user = await createUser(ctx);
      const make = async (room: number) => String((await holdHotel(user, { hotelId, roomIds: [roomIds[room]] })).body._id);
      const confirmed = await make(0);
      await confirmBooking(ctx, user, 'hotel', confirmed);
      const inProgress = await make(1);
      const finished = await make(2);
      const lapsed = await make(3);
      const expired = await make(4);
      const completed = await make(5);
      const hb = model('HotelBooking');
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      await hb.updateOne({ _id: inProgress }, { $set: { status: 'Confirmed', checkInDate: new Date(today.getTime() - 86_400_000), checkOutDate: today } });
      await hb.updateOne({ _id: finished }, { $set: { status: 'Confirmed', checkInDate: new Date(today.getTime() - 3 * 86_400_000), checkOutDate: new Date(today.getTime() - 2 * 86_400_000) } });
      await hb.updateOne({ _id: lapsed }, { $set: { holdExpiresAt: ago(1000) } });
      await hb.updateOne({ _id: expired }, { $set: { status: 'Expired' } });
      await hb.updateOne({ _id: completed }, { $set: { status: 'Completed' } });

      const list = (q: string) => user.agent.get(`/api/hotel-bookings?limit=100&group=${q}`);
      expect(ids(await list('upcoming'))).toEqual([confirmed, inProgress].sort());
      expect(ids(await list('past'))).toEqual([finished, completed].sort());
      expect(ids(await list('cancelled'))).toEqual([lapsed, expired].sort());
      expect((await user.agent.get('/api/hotel-bookings?group=PAST')).status).toBe(400);
    });
  });

  describe('e-ticket alias (FLT-23)', () => {
    const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const get = (agent: any, path: string) => agent.get(path).buffer(true).parse(binary);

    it('GET /flight-bookings/:id/e-ticket behaves exactly like GET /bookings/:id/e-ticket', async () => {
      const { flightId } = await createAirlineWithFlight(ctx, { seats: 4 });
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      const pending = String((await holdFlight(user, { flightId })).body._id);
      await confirmBooking(ctx, user, 'flight', hold.body._id);
      for (const base of ['/api/bookings', '/api/flight-bookings']) {
        const ok = await get(user.agent, `${base}/${hold.body._id}/e-ticket`);
        expect(ok.status).toBe(200);
        expect(ok.headers['content-type']).toMatch(/^application\/pdf/);
        expect(ok.headers['content-disposition']).toBe(`attachment; filename="e-ticket-${hold.body.reference}.pdf"`);
        expect(ok.body.subarray(0, 5).toString()).toBe('%PDF-');
        expect((await get(user.agent, `${base}/${pending}/e-ticket`)).status).toBe(409);
        expect((await get((await createUser(ctx)).agent, `${base}/${hold.body._id}/e-ticket`)).status).toBe(404);
        expect((await get((await createUser(ctx, 'admin')).agent, `${base}/${hold.body._id}/e-ticket`)).status).toBe(200);
        expect((await ctx.http().get(`${base}/${hold.body._id}/e-ticket`)).status).toBe(401);
        expect((await user.agent.get(`${base}/nope/e-ticket`)).status).toBe(400);
      }
    });
  });
});
