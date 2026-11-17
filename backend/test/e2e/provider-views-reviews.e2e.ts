import { Types } from 'mongoose';

import { HotelsService } from '../../src/modules/hotels/hotels.service';

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
  describe('airline view of a flight and the passenger CSV (FLT-29)', () => {
    const csvOf = (agent: any, flightId: string) => agent.get(`/api/flights/${flightId}/passengers/export`);

    /** A flight with a Confirmed booking of an adult + child + infant, a Pending hold and a Completed booking. */
    async function bookedFlight() {
      const f = await createAirlineWithFlight(ctx, { seats: 10, departInDays: 30 });
      const family = await createUser(ctx);
      const departure = new Date(`${day(30)}T08:00:00.000Z`);
      const yearsBefore = (years: number) => `${departure.getUTCFullYear() - years}-01-01`;
      const familyHold = await holdFlight(family, {
        flightId: f.flightId,
        body: { passengers: [
          { fullName: 'Adult Traveller', dateOfBirth: '1985-03-01' },
          { fullName: 'Child Traveller', dateOfBirth: yearsBefore(6) },
          { fullName: 'Infant Traveller', dateOfBirth: yearsBefore(1) },
        ] },
      });
      await confirmBooking(ctx, family, 'flight', familyHold.body._id);
      const pending = await holdFlight(await createUser(ctx), { flightId: f.flightId });
      const doneUser = await createUser(ctx);
      const done = await holdFlight(doneUser, { flightId: f.flightId, body: { passengers: [{ fullName: '=HYPERLINK("http://evil","x")', dateOfBirth: '1990-01-01' }, { fullName: 'Doe, "Jo"', dateOfBirth: '1991-01-01' }] } });
      await confirmBooking(ctx, doneUser, 'flight', done.body._id);
      await model('FlightBooking').updateOne({ _id: done.body._id }, { $set: { status: 'Completed' } });
      return { ...f, familyHold, pending, done };
    }

    it('lists one row per booking with passengers, cabin, counts by type and booked-at, plus seats left per cabin', async () => {
      const f = await bookedFlight();
      const res = await f.moderator.agent.get(`/api/flights/${f.flightId}/bookings`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, limit: 10, total: 3, pages: 1 });
      expect(res.body.flight).toMatchObject({ id: f.flightId, status: 'Scheduled' });
      expect(res.body.cabins).toEqual([{ cabinClass: 'Economy', totalSeats: 10, availableSeats: 4 }]);
      const family = res.body.items.find((i: any) => i.bookingId === f.familyHold.body._id);
      expect(family).toMatchObject({
        reference: f.familyHold.body.reference,
        status: 'Confirmed',
        cabinClass: 'Economy',
        passengers: ['Adult Traveller', 'Child Traveller', 'Infant Traveller'],
        passengerCounts: { adults: 1, children: 1, infants: 1 },
      });
      expect(new Date(family.bookedAt).getTime()).toBeGreaterThan(Date.now() - 600_000);
      const times = res.body.items.map((i: any) => new Date(i.bookedAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('filters by status, pages by 10, and rejects an unknown status', async () => {
      const f = await bookedFlight();
      const pending = await f.moderator.agent.get(`/api/flights/${f.flightId}/bookings?status=Pending%20Payment`);
      expect(pending.body.items.map((i: any) => i.bookingId)).toEqual([f.pending.body._id]);
      expect((await f.moderator.agent.get(`/api/flights/${f.flightId}/bookings?status=Paid`)).status).toBe(400);
      expect((await f.moderator.agent.get(`/api/flights/${f.flightId}/bookings?limit=101`)).status).toBe(400);
    });

    it('exports Confirmed and Completed passengers as a CSV attachment, with injection-safe cells', async () => {
      const f = await bookedFlight();
      const res = await csvOf(f.moderator.agent, f.flightId);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="passengers-[A-Za-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv"$/);
      const lines = res.text.trimEnd().split('\r\n');
      expect(lines[0]).toBe('booking_reference,full_name,type,cabin,passport_or_id,nationality,status');
      expect(lines).toHaveLength(1 + 3 + 2);
      expect(lines).toContain(`${f.familyHold.body.reference},Child Traveller,child,Economy,,,Confirmed`);
      expect(lines).toContain(`${f.familyHold.body.reference},Infant Traveller,infant,Economy,,,Confirmed`);
      expect(lines).toContain(`${f.done.body.reference},"'=HYPERLINK(""http://evil"",""x"")",adult,Economy,,,Completed`);
      expect(lines).toContain(`${f.done.body.reference},"Doe, ""Jo""",adult,Economy,,,Completed`);
      expect(res.text).not.toContain(f.pending.body.reference);
    });

    it.each(['bookings', 'passengers/export'])('%s: another airline\'s moderator, a hotel moderator and a user get 403; signed out 401; admin 200', async (path) => {
      const f = await createAirlineWithFlight(ctx, { seats: 2 });
      const other = await createAirlineWithFlight(ctx, { seats: 2 });
      const { moderator: hotelModerator } = await createHotelWithRooms(ctx, { rooms: 1 });
      const url = `/api/flights/${f.flightId}/${path}`;
      expect((await other.moderator.agent.get(url)).status).toBe(403);
      expect((await hotelModerator.agent.get(url)).status).toBe(403);
      expect((await (await createUser(ctx)).agent.get(url)).status).toBe(403);
      expect((await ctx.http().get(url)).status).toBe(401);
      expect((await (await createUser(ctx, 'admin')).agent.get(url)).status).toBe(200);
      expect((await f.moderator.agent.get(url)).status).toBe(200);
      expect((await f.moderator.agent.get(`/api/flights/nope/${path}`)).status).toBe(400);
      expect((await f.moderator.agent.get(`/api/flights/507f1f77bcf86cd799439011/${path}`)).status).toBe(404);
    });
  });
  describe('hotel reservations (HTL-22)', () => {
    async function hotelWithStays() {
      const h = await createHotelWithRooms(ctx, { rooms: 3 });
      const [alice, bob, carol] = [await createUser(ctx, 'user', { name: 'Alice Guest' }), await createUser(ctx), await createUser(ctx)];
      const a = await holdHotel(alice, { hotelId: h.hotelId, roomIds: [h.roomIds[0]], checkIn: day(10), checkOut: day(13) });
      await confirmBooking(ctx, alice, 'hotel', a.body._id);
      const b = await holdHotel(bob, { hotelId: h.hotelId, roomIds: [h.roomIds[1]], checkIn: day(20), checkOut: day(23) });
      const c = await holdHotel(carol, { hotelId: h.hotelId, roomIds: [h.roomIds[2]], checkIn: day(40), checkOut: day(41) });
      await model('HotelBooking').updateOne({ _id: c.body._id }, { $set: { status: 'Expired' } });
      // A booking at another hotel must never show up here.
      const elsewhere = await createHotelWithRooms(ctx, { rooms: 1 });
      expect((await holdHotel(await createUser(ctx), { hotelId: elsewhere.hotelId, roomIds: elsewhere.roomIds })).status).toBe(201);
      return { ...h, alice, bob, carol, a, b, c };
    }
    const list = (agent: any, hotelId: string, q = '') => agent.get(`/api/hotels/${hotelId}/reservations${q}`);

    it('lists the hotel\'s reservations newest first with guest, rooms, dates, status, total and reference', async () => {
      const h = await hotelWithStays();
      const res = await list(h.moderator.agent, h.hotelId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, limit: 10, total: 3, pages: 1 });
      expect(res.body.items.map((i: any) => i.bookingId)).toEqual([h.c.body._id, h.b.body._id, h.a.body._id]);
      expect(res.body.items[2]).toMatchObject({
        reference: h.a.body.reference,
        guest: { name: 'Alice Guest' },
        rooms: [{ roomId: h.roomIds[0], roomName: expect.any(String) }],
        checkInDate: `${day(10)}T00:00:00.000Z`,
        checkOutDate: `${day(13)}T00:00:00.000Z`,
        status: 'Confirmed',
        totalPrice: 4500,
        currency: 'EGP',
      });
    });

    it('filters by status and by stays overlapping from/to (both days included)', async () => {
      const h = await hotelWithStays();
      const ids = async (q: string) => (await list(h.moderator.agent, h.hotelId, q)).body.items.map((i: any) => i.bookingId);
      expect(await ids('?status=Confirmed')).toEqual([h.a.body._id]);
      expect(await ids(`?from=${day(12)}&to=${day(12)}`)).toEqual([h.a.body._id]);
      expect(await ids(`?from=${day(13)}&to=${day(19)}`)).toEqual([h.a.body._id]);
      expect(await ids(`?from=${day(14)}&to=${day(20)}`)).toEqual([h.b.body._id]);
      expect(await ids(`?from=${day(21)}`)).toEqual([h.c.body._id, h.b.body._id]);
      expect(await ids(`?to=${day(9)}`)).toEqual([]);
    });

    it('rejects bad filters with 400 on the field', async () => {
      const h = await createHotelWithRooms(ctx, { rooms: 1 });
      const field = async (q: string) => (await list(h.moderator.agent, h.hotelId, q)).body.errors?.[0]?.field;
      expect(await field(`?from=${day(5)}&to=${day(4)}`)).toBe('to');
      expect(await field('?from=2026-13-01')).toBe('from');
      expect(await field('?status=Paid')).toBe('status');
      expect(await field('?limit=101')).toBe('limit');
    });

    it('shows "Deleted user" for a deactivated guest', async () => {
      const h = await hotelWithStays();
      await model('User').updateOne({ _id: h.alice.id }, { $set: { isActive: false, deactivatedAt: new Date() } });
      const res = await list(h.moderator.agent, h.hotelId, '?status=Confirmed');
      expect(res.body.items[0].guest).toEqual({ name: 'Deleted user' });
    });

    it('only that hotel\'s moderator or an admin: others 403, signed out 401, unknown hotel 404, bad id 400', async () => {
      const h = await createHotelWithRooms(ctx, { rooms: 1 });
      const other = await createHotelWithRooms(ctx, { rooms: 1 });
      const { moderator: airlineModerator } = await createAirlineWithFlight(ctx, { seats: 1 });
      expect((await list(other.moderator.agent, h.hotelId)).status).toBe(403);
      expect((await list(airlineModerator.agent, h.hotelId)).status).toBe(403);
      expect((await list((await createUser(ctx)).agent, h.hotelId)).status).toBe(403);
      expect((await ctx.http().get(`/api/hotels/${h.hotelId}/reservations`)).status).toBe(401);
      expect((await list((await createUser(ctx, 'admin')).agent, h.hotelId)).status).toBe(200);
      expect((await list(h.moderator.agent, '507f1f77bcf86cd799439011')).status).toBe(404);
      expect((await list(h.moderator.agent, 'nope')).status).toBe(400);
    });
  });
  describe('reviews (HTL-23) and the public review list (HTL-24)', () => {
    /** A Completed stay at `hotelId` (a new hotel when omitted). */
    async function completedStay(opts: { hotelId?: string; roomId?: string; user?: TestUser; checkIn?: number } = {}) {
      let hotelId = opts.hotelId;
      let roomId = opts.roomId;
      let moderator: TestUser | undefined;
      if (!hotelId || !roomId) {
        const h = await createHotelWithRooms(ctx, { rooms: 1 });
        hotelId = h.hotelId;
        roomId = h.roomIds[0];
        moderator = h.moderator;
      }
      const user = opts.user ?? (await createUser(ctx));
      const checkIn = opts.checkIn ?? 10;
      const hold = await holdHotel(user, { hotelId, roomIds: [roomId], checkIn: day(checkIn), checkOut: day(checkIn + 1) });
      if (hold.status !== 201) throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.body)}`);
      await confirmBooking(ctx, user, 'hotel', hold.body._id);
      await model('HotelBooking').updateOne({ _id: hold.body._id }, { $set: { status: 'Completed' } });
      return { user, bookingId: String(hold.body._id), hotelId, roomId, moderator };
    }
    const review = (user: TestUser, bookingId: string, body: Record<string, unknown>) => user.agent.post(`/api/hotel-bookings/${bookingId}/review`).send(body);
    const stored = async (hotelId: string) => {
      const h = (await model('Hotel').findById(hotelId).lean()) as any;
      return { averageRating: h.averageRating, ratingCount: h.ratingCount };
    };
    const publicList = (hotelId: string, q = '') => ctx.http().get(`/api/hotels/${hotelId}/reviews${q}`);

    it('only a Completed stay can be reviewed, by its owner', async () => {
      const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 2 });
      const user = await createUser(ctx);
      const pending = await holdHotel(user, { hotelId, roomIds: [roomIds[0]] });
      expect((await review(user, pending.body._id, { rating: 5 })).status).toBe(409);
      const confirmed = await holdHotel(user, { hotelId, roomIds: [roomIds[1]] });
      await confirmBooking(ctx, user, 'hotel', confirmed.body._id);
      const notYet = await review(user, confirmed.body._id, { rating: 5 });
      expect(notYet.status).toBe(409);
      expect(notYet.body.message).toMatch(/Completed/);

      const stay = await completedStay();
      expect((await review(await createUser(ctx), stay.bookingId, { rating: 5 })).status).toBe(404);
      expect((await ctx.http().post(`/api/hotel-bookings/${stay.bookingId}/review`).send({ rating: 5 })).status).toBe(401);
      const ok = await review(stay.user, stay.bookingId, { rating: 4, comment: '  Nice view  ' });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ hotelId: stay.hotelId, bookingId: stay.bookingId, rating: 4, comment: 'Nice view' });
    });

    it('one review per reservation: a second is 409 and nothing is counted twice', async () => {
      const stay = await completedStay();
      expect((await review(stay.user, stay.bookingId, { rating: 5 })).status).toBe(201);
      expect((await review(stay.user, stay.bookingId, { rating: 1 })).status).toBe(409);
      expect(await stored(stay.hotelId)).toEqual({ averageRating: 5, ratingCount: 1 });
      expect(await model('Review').countDocuments({ bookingId: stay.bookingId })).toBe(1);
    });

    it.each([
      ['rating 0', { rating: 0 }, 'rating'],
      ['rating 6', { rating: 6 }, 'rating'],
      ['rating 4.5', { rating: 4.5 }, 'rating'],
      ['rating "5" (a string)', { rating: '5' }, 'rating'],
      ['no rating', { comment: 'hi' }, 'rating'],
      ['a 1001-character comment', { rating: 3, comment: 'x'.repeat(1001) }, 'comment'],
      ['a non-string comment', { rating: 3, comment: 5 }, 'comment'],
      ['an unknown field', { rating: 3, stars: 3 }, 'stars'],
    ])('%s is 400 on that field', async (_name, body, field) => {
      const stay = await completedStay();
      const res = await review(stay.user, stay.bookingId, body);
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: any) => e.field)).toContain(field);
      expect(await model('Review').countDocuments({ bookingId: stay.bookingId })).toBe(0);
    });

    it('a 1000-character comment is accepted; a bad booking id is 400', async () => {
      const stay = await completedStay();
      expect((await review(stay.user, stay.bookingId, { rating: 3, comment: 'x'.repeat(1000) })).status).toBe(201);
      expect((await review(stay.user, 'nope', { rating: 3 })).status).toBe(400);
    });

    it('the stored average and count follow every create, edit and delete; the last delete makes the hotel unrated', async () => {
      const first = await completedStay({ checkIn: 10 });
      const second = await completedStay({ hotelId: first.hotelId, roomId: first.roomId, checkIn: 20 });
      const r1 = (await review(first.user, first.bookingId, { rating: 5 })).body;
      const r2 = (await review(second.user, second.bookingId, { rating: 2 })).body;
      expect(await stored(first.hotelId)).toEqual({ averageRating: 3.5, ratingCount: 2 });

      const edit = await second.user.agent.patch(`/api/reviews/${r2.id}`).send({ rating: 4, comment: 'Better on reflection' });
      expect(edit.status).toBe(200);
      expect(edit.body).toMatchObject({ rating: 4, comment: 'Better on reflection' });
      expect(await stored(first.hotelId)).toEqual({ averageRating: 4.5, ratingCount: 2 });

      const search = () => ctx.http().get('/api/hotels/search').query({ city: 'cairo', checkIn: day(50), checkOut: day(51), guests: 1, minRating: 4.5, limit: 100 });
      expect(JSON.stringify((await search()).body)).toContain(first.hotelId);

      expect((await (await createUser(ctx, 'admin')).agent.delete(`/api/reviews/${r1.id}`)).status).toBe(200);
      expect(await stored(first.hotelId)).toEqual({ averageRating: 4, ratingCount: 1 });
      expect(JSON.stringify((await search()).body)).not.toContain(first.hotelId);

      expect((await second.user.agent.delete(`/api/reviews/${r2.id}`)).body).toEqual({ id: r2.id, deleted: true });
      expect(await stored(first.hotelId)).toEqual({ averageRating: null, ratingCount: 0 });
      expect((await publicList(first.hotelId)).body).toMatchObject({ averageRating: null, ratingCount: 0, total: 0, items: [] });
    });

    it('edit: author only (others 404), same validation, empty body 400; delete: author or admin (others 404)', async () => {
      const stay = await completedStay();
      const { id } = (await review(stay.user, stay.bookingId, { rating: 3 })).body;
      const stranger = await createUser(ctx);
      expect((await stranger.agent.patch(`/api/reviews/${id}`).send({ rating: 1 })).status).toBe(404);
      expect((await (await createUser(ctx, 'admin')).agent.patch(`/api/reviews/${id}`).send({ rating: 1 })).status).toBe(404);
      expect((await stay.user.agent.patch(`/api/reviews/${id}`).send({ rating: 6 })).status).toBe(400);
      expect((await stay.user.agent.patch(`/api/reviews/${id}`).send({ comment: 'x'.repeat(1001) })).status).toBe(400);
      expect((await stay.user.agent.patch(`/api/reviews/${id}`).send({})).status).toBe(400);
      expect((await stay.user.agent.patch(`/api/reviews/${id}`).send({ rating: 2, hotelId: stay.hotelId })).status).toBe(400);
      expect((await stay.user.agent.patch('/api/reviews/nope').send({ rating: 2 })).status).toBe(400);
      expect((await stranger.agent.delete(`/api/reviews/${id}`)).status).toBe(404);
      expect((await ctx.http().delete(`/api/reviews/${id}`)).status).toBe(401);
      expect(await stored(stay.hotelId)).toEqual({ averageRating: 3, ratingCount: 1 });
    });

    it('a review hidden by moderation no longer counts and is not listed', async () => {
      const stay = await completedStay();
      const { id } = (await review(stay.user, stay.bookingId, { rating: 1 })).body;
      const report = await (await createUser(ctx)).agent.post('/api/reports').send({ targetType: 'review', targetId: id, reason: 'Offensive language' });
      expect(report.status).toBe(201);
      const moderated = await (await createUser(ctx, 'admin')).agent.patch(`/api/admin/reports/${report.body.report.id}`).send({ action: 'hide' });
      expect(moderated.status).toBe(200);
      expect(await stored(stay.hotelId)).toEqual({ averageRating: null, ratingCount: 0 });
      expect((await publicList(stay.hotelId)).body.total).toBe(0);
    });

    it('public list: newest first, 10 per page, average and count, "Deleted user" for deactivated authors, hidden left out', async () => {
      const { hotelId } = await createHotelWithRooms(ctx, { rooms: 1 });
      const authors = await Promise.all(Array.from({ length: 12 }, () => createUser(ctx)));
      const base = Date.now();
      await model('Review').insertMany(
        authors.map((a, i) => ({ hotelId, userId: a.id, bookingId: new Types.ObjectId(), rating: (i % 5) + 1, comment: `Review ${i}`, createdAt: new Date(base - i * 60_000) })),
      );
      await model('Review').create({ hotelId, userId: authors[0].id, bookingId: new Types.ObjectId(), rating: 5, isHidden: true });
      await ctx.get(HotelsService).refreshRating(hotelId);
      await model('User').updateOne({ _id: authors[0].id }, { $set: { isActive: false, deactivatedAt: new Date() } });

      const page1 = await publicList(hotelId);
      expect(page1.status).toBe(200);
      expect(page1.body).toMatchObject({ averageRating: 2.75, ratingCount: 12, page: 1, limit: 10, total: 12, pages: 2 });
      expect(page1.body.items).toHaveLength(10);
      expect(page1.body.items[0]).toEqual({ id: expect.any(String), rating: 1, comment: 'Review 0', author: { name: 'Deleted user' }, createdAt: expect.any(String), updatedAt: expect.any(String) });
      expect(page1.body.items[1].author.name).toBe(authors[1].name);
      expect((await publicList(hotelId, '?page=2')).body.items.map((r: any) => r.comment)).toEqual(['Review 10', 'Review 11']);
      expect((await publicList(hotelId, '?limit=101')).status).toBe(400);

      const details = await ctx.http().get(`/api/hotels/${hotelId}`);
      expect(details.body).toMatchObject({ averageRating: 2.75, ratingCount: 12 });
      expect(details.body.reviews).toHaveLength(10);
      expect(details.body.reviews[0].comment).toBe('Review 0');
    });

    it('an unknown, inactive or malformed hotel id is 404 / 404 / 400; the owner may still review a deactivated hotel', async () => {
      expect((await publicList('507f1f77bcf86cd799439011')).status).toBe(404);
      expect((await publicList('nope')).status).toBe(400);
      const stay = await completedStay();
      await model('Hotel').updateOne({ _id: stay.hotelId }, { $set: { isActive: false } });
      expect((await publicList(stay.hotelId)).status).toBe(404);
      expect((await review(stay.user, stay.bookingId, { rating: 4 })).status).toBe(201);
    });
  });
});
