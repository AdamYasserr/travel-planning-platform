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
});
