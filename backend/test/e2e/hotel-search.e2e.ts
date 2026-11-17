import { Types } from 'mongoose';

import { HotelsService } from '../../src/modules/hotels/hotels.service';
import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdHotel } from './helpers/bookings';
import { createHotelWithRooms, createUser, day, type HotelFixture, type RoomSpec, type TestUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

const IN = () => day(10);
const OUT = () => day(13);

describe('hotel search, room availability and room management (HTL-04, 05, 06, 08, 11, 12, 15)', () => {
  let ctx: E2EContext;
  let user: TestUser;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
    await ctx.conn.model('City').create({ cityId: 'alexandria', name: 'Alexandria', countryCode: 'EG' });
    user = await createUser(ctx);
  });
  afterAll(() => ctx.close());
  // Hotels, rooms, bookings and reviews are wiped before every test, so each test starts from an empty catalogue.
  beforeEach(async () => {
    await Promise.all(['Hotel', 'Room', 'HotelBooking', 'Review', 'Payment'].map((m) => ctx.conn.model(m).deleteMany({})));
  });

  // ---------- helpers ----------
  const search = (q: Record<string, unknown> = {}) => ctx.http().get('/api/hotels/search').query({ city: 'cairo', checkIn: IN(), checkOut: OUT(), guests: 2, ...q });
  const ids = (res: any) => res.body.items.map((i: any) => i.id);
  const expectBadField = (res: any, ...fields: string[]) => {
    expect(res.status).toBe(400);
    const got = res.body.errors.map((e: any) => e.field);
    for (const f of fields) expect(got).toContain(f);
  };
  const hotel = (opts: Parameters<typeof createHotelWithRooms>[1] = {}) => createHotelWithRooms(ctx, opts);
  const roomsOf = (h: HotelFixture, n: number) => h.roomIds.slice(0, n);
  const patchRoom = (roomId: string, set: Record<string, unknown>) => ctx.conn.model('Room').updateOne({ _id: roomId }, { $set: set });
  const holdRoom = (who: TestUser, h: HotelFixture, roomIds: string[], checkIn = IN(), checkOut = OUT()) => holdHotel(who, { hotelId: h.hotelId, roomIds, checkIn, checkOut });
  const range = (a: number, b: number) => ({ startDate: day(a), endDate: day(b) });
  const setRanges = (h: HotelFixture, roomId: string, ranges: Array<{ startDate: string; endDate: string }>) =>
    h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${roomId}/availability`).send({ availabilityRanges: ranges });
  const block = (h: HotelFixture, roomId: string, a: number, b: number) =>
    h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${roomId}/blocks`).send({ blockedRanges: [range(a, b)] });
  const available = (hotelId: string, q: Record<string, unknown> = {}) => ctx.http().get(`/api/hotels/${hotelId}/rooms/available`).query({ checkIn: IN(), checkOut: OUT(), ...q });
  const rate = async (hotelId: string, ratings: number[], hidden: number[] = []) => {
    for (const rating of ratings) await ctx.conn.model('Review').create({ hotelId, userId: new Types.ObjectId(), bookingId: new Types.ObjectId(), rating });
    for (const rating of hidden) await ctx.conn.model('Review').create({ hotelId, userId: new Types.ObjectId(), bookingId: new Types.ObjectId(), rating, isHidden: true });
    return ctx.get(HotelsService).refreshRating(hotelId);
  };

  // ---------- guest search ----------
  describe('HTL-11: guest search', () => {
    it('a guest finds an active hotel with a free room and sees the summary', async () => {
      const h = await hotel({ name: 'Nile View', starClass: 5, roomSpecs: [{ price: 1800 }, { price: 1200 }] });
      const res = await search();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, limit: 10, total: 1, pages: 1 });
      expect(res.body.items[0]).toEqual({
        id: h.hotelId, name: 'Nile View', starClass: 5, photo: null,
        city: { city_id: 'cairo', name: 'Cairo' }, country: { code: 'EG', name: 'Egypt' },
        averageRating: null, ratingCount: 0, cheapestPricePerNight: 1200, currency: 'EGP', freeRooms: 2, nights: 3,
      });
    });

    it('a signed-in user gets the same result', async () => {
      const h = await hotel();
      expect(ids(await user.agent.get('/api/hotels/search').query({ city: 'cairo', checkIn: IN(), checkOut: OUT(), guests: 2 }))).toEqual([h.hotelId]);
    });

    it('city searches one city; country searches every city of the country', async () => {
      const cairo = await hotel({ cityId: 'cairo', countryId: 'EG' });
      const alex = await hotel({ cityId: 'alexandria', countryId: 'EG' });
      const dubai = await hotel({ cityId: 'dubai', countryId: 'AE' });
      expect(ids(await search({ city: 'cairo' }))).toEqual([cairo.hotelId]);
      expect(ids(await search({ city: undefined, country: 'EG' })).sort()).toEqual([cairo.hotelId, alex.hotelId].sort());
      expect(ids(await search({ city: undefined, country: 'AE' }))).toEqual([dubai.hotelId]);
      expect(ids(await search({ city: undefined, country: 'eg' })).sort()).toEqual([cairo.hotelId, alex.hotelId].sort()); // case-insensitive
    });

    it('an unknown (but well-formed) city or country is an empty 200 with "No hotels found"', async () => {
      await hotel();
      for (const q of [{ city: 'atlantis' }, { city: undefined, country: 'ZZ' }]) {
        const res = await search(q);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ items: [], total: 0, pages: 0, message: 'No hotels found' });
      }
    });

    it('no match because of the stay is the same empty 200', async () => {
      const h = await hotel({ availability: range(1, 8) });
      expect(h).toBeDefined();
      expect((await search()).body).toMatchObject({ items: [], total: 0, message: 'No hotels found' });
    });
  });

  // ---------- the free-room rule ----------
  describe('a room is free for the WHOLE stay', () => {
    it('the whole stay must fall inside the bookable ranges: a partial overlap excludes the room', async () => {
      const full = await hotel({ availability: range(1, 120) });
      const startsLate = await hotel({ availability: range(11, 120) }); // misses the first night
      const endsEarly = await hotel({ availability: range(1, 12) }); // misses the last night
      const exact = await hotel({ availability: range(10, 13) }); // boundaries equal to the stay
      expect(ids(await search()).sort()).toEqual([full.hotelId, exact.hotelId].sort());
      expect(ids(await search())).not.toContain(startsLate.hotelId);
      expect(ids(await search())).not.toContain(endsEarly.hotelId);
    });

    it('ranges that touch count as one: 1-11 and 11-120 cover a stay across the 11th', async () => {
      const h = await hotel({ rooms: 1, availability: range(1, 11) });
      expect((await setRanges(h, h.roomIds[0], [range(1, 11), range(11, 120)])).status).toBe(200);
      expect(ids(await search())).toEqual([h.hotelId]);
      expect((await available(h.hotelId)).body.items.map((r: any) => r.id)).toEqual(h.roomIds);
      expect((await holdRoom(user, h, h.roomIds)).status).toBe(201);
    });

    it('a real gap between ranges, even one night, makes the room not free', async () => {
      const h = await hotel({ rooms: 1, availability: range(1, 11) });
      expect((await setRanges(h, h.roomIds[0], [range(1, 11), range(12, 120)])).status).toBe(200); // night of the 11th is missing
      expect(ids(await search())).toEqual([]);
      expect((await available(h.hotelId)).body.items).toEqual([]);
      expect((await holdRoom(user, h, h.roomIds)).status).toBe(409);
    });

    it('a Confirmed booking excludes the room, and a back-to-back stay does not', async () => {
      const h = await hotel({ rooms: 1 });
      const guest = await createUser(ctx);
      const hold = await holdRoom(guest, h, h.roomIds, day(7), day(10));
      await confirmBooking(ctx, guest, 'hotel', hold.body._id);
      expect(ids(await search())).toEqual([h.hotelId]); // check-out day 10 = check-in day 10: no overlap
      const overlap = await holdRoom(await createUser(ctx), h, h.roomIds, day(12), day(15));
      await confirmBooking(ctx, guest, 'hotel', (await holdRoom(guest, h, h.roomIds, day(15), day(16))).body._id);
      expect(overlap.status).toBe(201); // sanity: the hold above was for a free window
      expect(ids(await search())).toEqual([]); // the unexpired hold on 12-15 overlaps 10-13
    });

    it('a Confirmed booking on the stay excludes the hotel', async () => {
      const h = await hotel({ rooms: 1 });
      const guest = await createUser(ctx);
      const hold = await holdRoom(guest, h, h.roomIds, day(11), day(12));
      await confirmBooking(ctx, guest, 'hotel', hold.body._id);
      expect(ids(await search())).toEqual([]);
    });

    it('an unexpired hold excludes the room; an EXPIRED hold does not (even before the job runs)', async () => {
      const h = await hotel({ rooms: 1 });
      const hold = await holdRoom(await createUser(ctx), h, h.roomIds);
      expect(hold.status).toBe(201);
      expect(ids(await search())).toEqual([]);
      await ctx.conn.model('HotelBooking').updateOne({ _id: hold.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      expect(ids(await search())).toEqual([h.hotelId]);
      expect((await available(h.hotelId)).body.items).toHaveLength(1);
    });

    it('Cancelled and Expired reservations do not exclude a room', async () => {
      const h = await hotel({ rooms: 1 });
      const guest = await createUser(ctx);
      const hold = await holdRoom(guest, h, h.roomIds);
      await confirmBooking(ctx, guest, 'hotel', hold.body._id);
      expect(ids(await search())).toEqual([]);
      expect((await guest.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`)).status).toBe(200);
      expect(ids(await search())).toEqual([h.hotelId]);
      const second = await holdRoom(guest, h, h.roomIds);
      await guest.agent.post(`/api/hotel-bookings/${second.body._id}/cancel`); // unpaid hold -> Expired
      expect(ids(await search())).toEqual([h.hotelId]);
    });

    it('a blocked range that overlaps the stay excludes the room; one elsewhere does not', async () => {
      const [a, b] = [await hotel({ rooms: 1 }), await hotel({ rooms: 1 })];
      expect((await block(a, a.roomIds[0], 11, 12)).status).toBe(200);
      expect((await block(b, b.roomIds[0], 20, 25)).status).toBe(200);
      expect(ids(await search())).toEqual([b.hotelId]);
    });

    it('a deactivated room is excluded; a hotel left with no active room, and a deactivated hotel, are excluded', async () => {
      const [partly, none, off] = [await hotel({ rooms: 2 }), await hotel({ rooms: 1 }), await hotel({ rooms: 1 })];
      expect((await partly.moderator.agent.patch(`/api/hotels/${partly.hotelId}/rooms/${partly.roomIds[0]}/deactivate`)).status).toBe(200);
      expect((await none.moderator.agent.patch(`/api/hotels/${none.hotelId}/rooms/${none.roomIds[0]}/deactivate`)).status).toBe(200);
      expect((await off.admin.agent.patch(`/api/admin/providers/hotel/${off.hotelId}/deactivate`)).status).toBe(200);
      const res = await search();
      expect(ids(res)).toEqual([partly.hotelId]);
      expect(res.body.items[0].freeRooms).toBe(1);
    });
  });

  // ---------- several rooms and guests ----------
  describe('rooms and guests', () => {
    it('rooms=2 needs two free rooms', async () => {
      const h = await hotel({ rooms: 3 });
      await holdRoom(await createUser(ctx), h, [h.roomIds[0], h.roomIds[1]]); // one room left
      expect(ids(await search({ rooms: 1 }))).toEqual([h.hotelId]);
      expect(ids(await search({ rooms: 2 }))).toEqual([]);
      const full = await hotel({ rooms: 3 });
      const res = await search({ rooms: 2, city: 'cairo' });
      expect(ids(res)).toEqual([full.hotelId]);
      expect(res.body.items[0].freeRooms).toBe(3);
      expect(ids(await search({ rooms: 4 }))).toEqual([]);
    });

    it('rooms defaults to 1', async () => {
      const h = await hotel({ rooms: 1 });
      expect(ids(await search())).toEqual([h.hotelId]);
      expect(ids(await search({ rooms: 2 }))).toEqual([]);
    });

    it('the best `rooms` rooms by occupancy together must hold all the guests', async () => {
      const h = await hotel({ roomSpecs: [{ maxOccupancy: 2 }, { maxOccupancy: 2 }, { maxOccupancy: 4 }] });
      expect(ids(await search({ guests: 4, rooms: 1 }))).toEqual([h.hotelId]);
      expect(ids(await search({ guests: 5, rooms: 1 }))).toEqual([]); // the biggest room holds 4
      expect(ids(await search({ guests: 6, rooms: 2 }))).toEqual([h.hotelId]); // 4 + 2
      expect(ids(await search({ guests: 7, rooms: 2 }))).toEqual([]);
      expect(ids(await search({ guests: 8, rooms: 3 }))).toEqual([h.hotelId]); // 4 + 2 + 2
      expect(ids(await search({ guests: 9, rooms: 3 }))).toEqual([]);
    });

    it('capacity only counts FREE rooms: booking the big room lowers what the hotel can hold', async () => {
      const h = await hotel({ roomSpecs: [{ maxOccupancy: 2 }, { maxOccupancy: 2 }, { maxOccupancy: 4 }] });
      expect(ids(await search({ guests: 4 }))).toEqual([h.hotelId]);
      await holdRoom(await createUser(ctx), h, [h.roomIds[2]]);
      expect(ids(await search({ guests: 4 }))).toEqual([]);
      expect(ids(await search({ guests: 4, rooms: 2 }))).toEqual([h.hotelId]);
    });
  });

  // ---------- price, rating, sorting, paging ----------
  describe('HTL-12: filters, sorting and paging', () => {
    it('the price filter uses the cheapest FREE room, inclusive at both ends', async () => {
      const h = await hotel({ roomSpecs: [{ name: 'Cheap', price: 500 }, { name: 'Mid', price: 900 }, { name: 'Dear', price: 2000 }] });
      expect((await search()).body.items[0].cheapestPricePerNight).toBe(500);
      expect(ids(await search({ maxPrice: 600 }))).toEqual([h.hotelId]);
      await holdRoom(await createUser(ctx), h, [h.roomIds[0]]); // the 500 room is no longer free
      const res = await search();
      expect(res.body.items[0].cheapestPricePerNight).toBe(900);
      expect(ids(await search({ maxPrice: 600 }))).toEqual([]);
      expect(ids(await search({ minPrice: 800 }))).toEqual([h.hotelId]);
      expect(ids(await search({ minPrice: 900, maxPrice: 900 }))).toEqual([h.hotelId]);
      expect(ids(await search({ minPrice: 900.01 }))).toEqual([]);
      expect(ids(await search({ maxPrice: 899.99 }))).toEqual([]);
    });

    it('the price filter keeps the other criteria', async () => {
      await hotel({ rooms: 1, pricePerNight: 700 });
      expect(ids(await search({ minPrice: 600, maxPrice: 800, city: 'dubai' }))).toEqual([]);
      expect(ids(await search({ minPrice: 600, maxPrice: 800, guests: 4 }))).toEqual([]); // rooms hold 3
      expect(ids(await search({ minPrice: 600, maxPrice: 800 }))).toHaveLength(1);
    });

    it('minPrice greater than maxPrice is 400; equal is fine', async () => {
      expectBadField(await search({ minPrice: 500, maxPrice: 100 }), 'minPrice');
      expect((await search({ minPrice: 100, maxPrice: 100 })).status).toBe(200);
    });

    it('refreshRating stores the average and count of visible reviews, and null / 0 when there are none', async () => {
      const h = await hotel({ rooms: 1 });
      expect(await ctx.get(HotelsService).refreshRating(h.hotelId)).toEqual({ averageRating: null, ratingCount: 0 });
      expect(await rate(h.hotelId, [5, 4], [1])).toEqual({ averageRating: 4.5, ratingCount: 2 }); // the hidden 1-star is ignored
      const stored: any = await ctx.conn.model('Hotel').findById(h.hotelId).lean();
      expect(stored).toMatchObject({ averageRating: 4.5, ratingCount: 2 });
    });

    it('unrated hotels show averageRating null / ratingCount 0, rated ones their stored values', async () => {
      const [rated, unrated] = [await hotel({ rooms: 1 }), await hotel({ rooms: 1 })];
      await rate(rated.hotelId, [5, 4, 4]);
      const res = await search();
      expect(res.body.items.find((i: any) => i.id === rated.hotelId)).toMatchObject({ averageRating: 4.33, ratingCount: 3 });
      expect(res.body.items.find((i: any) => i.id === unrated.hotelId)).toMatchObject({ averageRating: null, ratingCount: 0 });
    });

    it('minRating excludes unrated hotels and hotels below it, inclusively', async () => {
      const [five, four, three, unrated] = [await hotel({ rooms: 1 }), await hotel({ rooms: 1 }), await hotel({ rooms: 1 }), await hotel({ rooms: 1 })];
      await rate(five.hotelId, [5]); await rate(four.hotelId, [4]); await rate(three.hotelId, [3]);
      expect(ids(await search()).sort()).toEqual([five, four, three, unrated].map((h) => h.hotelId).sort());
      expect(ids(await search({ minRating: 1 })).sort()).toEqual([five, four, three].map((h) => h.hotelId).sort()); // unrated out
      expect(ids(await search({ minRating: 4 })).sort()).toEqual([five, four].map((h) => h.hotelId).sort()); // inclusive
      expect(ids(await search({ minRating: 4.5 }))).toEqual([five.hotelId]);
      expect(ids(await search({ minRating: 5 }))).toEqual([five.hotelId]);
    });

    it('sorts by price (cheapest free room) ascending and descending, price ascending by default', async () => {
      const [a, b, c] = [await hotel({ rooms: 1, pricePerNight: 900 }), await hotel({ rooms: 1, pricePerNight: 300 }), await hotel({ rooms: 1, pricePerNight: 600 })];
      expect(ids(await search())).toEqual([b.hotelId, c.hotelId, a.hotelId]);
      expect(ids(await search({ sortBy: 'price', order: 'asc' }))).toEqual([b.hotelId, c.hotelId, a.hotelId]);
      expect(ids(await search({ sortBy: 'price', order: 'desc' }))).toEqual([a.hotelId, c.hotelId, b.hotelId]);
    });

    it('sorts by rating (best first by default), either way, with unrated hotels always last', async () => {
      const [low, high, mid, unrated] = [await hotel({ rooms: 1 }), await hotel({ rooms: 1 }), await hotel({ rooms: 1 }), await hotel({ rooms: 1 })];
      await rate(low.hotelId, [2]); await rate(high.hotelId, [5]); await rate(mid.hotelId, [4]);
      expect(ids(await search({ sortBy: 'rating' }))).toEqual([high.hotelId, mid.hotelId, low.hotelId, unrated.hotelId]);
      expect(ids(await search({ sortBy: 'rating', order: 'desc' }))).toEqual([high.hotelId, mid.hotelId, low.hotelId, unrated.hotelId]);
      expect(ids(await search({ sortBy: 'rating', order: 'asc' }))).toEqual([low.hotelId, mid.hotelId, high.hotelId, unrated.hotelId]);
    });

    it('sorting uses the price of the cheapest FREE room', async () => {
      const [a, b] = [await hotel({ roomSpecs: [{ name: 'A1', price: 100 }, { name: 'A2', price: 800 }] }), await hotel({ roomSpecs: [{ name: 'B1', price: 400 }] })];
      expect(ids(await search())).toEqual([a.hotelId, b.hotelId]);
      await holdRoom(await createUser(ctx), a, [a.roomIds[0]]); // A's cheap room is held: its cheapest free room is now 800
      expect(ids(await search())).toEqual([b.hotelId, a.hotelId]);
    });

    it('pages of 10 by default; sorting and totals are applied before paging', async () => {
      const created: HotelFixture[] = [];
      const admin = await createUser(ctx, 'admin');
      for (let i = 0; i < 12; i++) created.push(await hotel({ admin, rooms: 1, pricePerNight: 1000 + i * 10 }));
      const first = await search();
      expect(first.body).toMatchObject({ page: 1, limit: 10, total: 12, pages: 2 });
      expect(first.body.items).toHaveLength(10);
      const second = await search({ page: 2 });
      expect(second.body.items).toHaveLength(2);
      expect([...ids(first), ...ids(second)]).toEqual(created.map((h) => h.hotelId)); // price ascending, no repeats
      expect(ids(await search({ sortBy: 'price', order: 'desc' }))[0]).toBe(created[11].hotelId);
      const filtered = await search({ minPrice: 1050 }); // 7 hotels: 1050..1110; totals reflect the filter
      expect(filtered.body).toMatchObject({ total: 7, pages: 1 });
      expect((await search({ limit: 5, page: 3 })).body.items).toHaveLength(2);
      expect((await search({ page: 3 })).body).toMatchObject({ items: [], total: 12 });
    });
  });

  // ---------- validation ----------
  describe('validation: every bad value is 400 on the right field', () => {
    it('check-out must be after check-in', async () => {
      expectBadField(await search({ checkIn: day(10), checkOut: day(10) }), 'checkOut');
      expectBadField(await search({ checkIn: day(12), checkOut: day(10) }), 'checkOut');
    });

    it('check-in cannot be in the past (today is allowed)', async () => {
      expectBadField(await search({ checkIn: day(-1), checkOut: day(2) }), 'checkIn');
      expect((await search({ checkIn: day(0), checkOut: day(2) })).status).toBe(200);
    });

    it.each([
      ['checkIn', '2026-02-30'], ['checkIn', '2026-1-5'], ['checkIn', '05/12/2026'], ['checkIn', '2030-12-05T10:00:00Z'], ['checkIn', 'tomorrow'],
      ['checkOut', '2027-02-29'], ['checkOut', 'soon'], ['checkOut', '2030-13-01'],
    ])('a malformed %s (%s) is 400 on that field', async (field, value) => {
      expectBadField(await search({ [field]: value }), field);
    });

    it.each(['checkIn', 'checkOut', 'guests'])('a missing %s is 400 on that field', async (field) => {
      const q: Record<string, unknown> = { city: 'cairo', checkIn: IN(), checkOut: OUT(), guests: 2 };
      delete q[field];
      expectBadField(await ctx.http().get('/api/hotels/search').query(q), field);
    });

    it('both city and country is 400', async () => {
      expectBadField(await search({ city: 'cairo', country: 'EG' }), 'city', 'country');
    });

    it('neither city nor country is 400', async () => {
      expectBadField(await search({ city: undefined }), 'city', 'country');
    });

    it('an unknown query parameter is 400', async () => {
      expectBadField(await search({ colour: 'blue' }), 'colour');
    });

    it.each([
      ['guests', 0], ['guests', -1], ['guests', 'two'], ['guests', 1.5], ['rooms', 0], ['rooms', 'x'], ['rooms', 2.5],
      ['minPrice', -1], ['minPrice', 'cheap'], ['maxPrice', 'abc'], ['maxPrice', '1e999'],
      ['minRating', 0], ['minRating', 6], ['minRating', 'good'],
      ['sortBy', 'stars'], ['sortBy', 'PRICE'], ['order', 'up'], ['order', 'ASC'],
      ['page', 0], ['page', 'x'], ['limit', 0], ['limit', 101], ['limit', 'ten'],
      ['city', 'bad id!'], ['country', 'EGY'], ['country', 'E1'],
    ])('a bad %s (%s) is 400 on that field', async (field, value) => {
      const q: Record<string, unknown> = field === 'country' ? { city: undefined, country: value } : { [field]: value };
      expectBadField(await search(q), field);
    });

    it('several mistakes are reported together, each on its own field', async () => {
      const res = await search({ checkIn: 'x', guests: 0, minRating: 9, sortBy: 'stars' });
      expect(res.body.errors.map((e: any) => e.field).sort()).toEqual(['checkIn', 'guests', 'minRating', 'sortBy']);
    });
  });

  // ---------- search agrees with booking ----------
  describe('search and booking use the same rule', () => {
    const scenarios: Array<[string, (h: HotelFixture) => Promise<void>]> = [
      ['a blocked range', async (h) => { await block(h, h.roomIds[0], 11, 12); }],
      ['a deactivated room', async (h) => { await h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[0]}/deactivate`); }],
      ['a Confirmed booking', async (h) => { const g = await createUser(ctx); await confirmBooking(ctx, g, 'hotel', (await holdRoom(g, h, h.roomIds)).body._id); }],
      ['an unexpired hold', async (h) => { await holdRoom(await createUser(ctx), h, h.roomIds); }],
      ['a gap in the availability ranges', async (h) => { await setRanges(h, h.roomIds[0], [range(1, 11), range(12, 120)]); }],
      ['availability that covers only part of the stay', async (h) => { await setRanges(h, h.roomIds[0], [range(11, 120)]); }],
    ];

    it.each(scenarios)('%s: the hotel is not returned by search AND a booking attempt is rejected with 409', async (_name, makeUnavailable) => {
      const h = await hotel({ rooms: 1 });
      await makeUnavailable(h);
      expect(ids(await search())).not.toContain(h.hotelId);
      expect((await available(h.hotelId)).body.items).toEqual([]);
      expect((await holdRoom(await createUser(ctx), h, h.roomIds)).status).toBe(409);
    });

    it('a hotel returned by search can be booked for the same stay, guests and rooms', async () => {
      const h = await hotel({ roomSpecs: [{ maxOccupancy: 2 }, { maxOccupancy: 3 }] });
      const res = await search({ guests: 5, rooms: 2 });
      expect(ids(res)).toEqual([h.hotelId]);
      const booked = await holdHotel(user, {
        hotelId: h.hotelId, roomIds: h.roomIds, checkIn: IN(), checkOut: OUT(),
        body: { rooms: [{ roomId: h.roomIds[0], adults: 2, childrenAges: [] }, { roomId: h.roomIds[1], adults: 3, childrenAges: [] }] },
      });
      expect(booked.status).toBe(201);
      expect(ids(await search({ guests: 5, rooms: 2 }))).toEqual([]); // and now it is gone
    });

    it('a Pending hold that has been paid and confirmed behaves the same as a hold for search', async () => {
      const h = await hotel({ rooms: 1 });
      const g = await createUser(ctx);
      const hold = await holdRoom(g, h, h.roomIds);
      expect(ids(await search())).toEqual([]);
      await confirmBooking(ctx, g, 'hotel', hold.body._id);
      expect(ids(await search())).toEqual([]);
    });

    it('RANDOM layouts: rooms/available, the moderator statuses, search and a real booking attempt agree', async () => {
      let seed = 20260101;
      const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
      const h = await hotel({ rooms: 6 });
      const patterns: Array<Array<[number, number]>> = [[[1, 60]], [[1, 20], [20, 60]], [[1, 20], [22, 60]], [[15, 60]], [[1, 30]], []];
      const dateOf = (n: number) => new Date(`${day(n)}T00:00:00.000Z`);
      const statuses = ['Confirmed', 'Pending Payment', 'expired-hold', 'Cancelled', 'Expired'];
      for (const roomId of h.roomIds) {
        const ranges = pick(patterns).map(([a, b]) => ({ startDate: dateOf(a), endDate: dateOf(b) }));
        const blocked = random() < 0.3 ? [{ startDate: dateOf(20 + Math.floor(random() * 10)), endDate: dateOf(32 + Math.floor(random() * 6)) }] : [];
        await patchRoom(roomId, { availabilityRanges: ranges, blockedRanges: blocked, isActive: random() > 0.1 });
        for (let k = 0; k < 2; k++) {
          if (random() < 0.5) continue;
          const checkIn = 5 + Math.floor(random() * 30);
          const status = pick(statuses);
          await ctx.conn.model('HotelBooking').collection.insertOne({
            userId: new Types.ObjectId(user.id), hotelId: new Types.ObjectId(h.hotelId), reference: `HTL-rand-${new Types.ObjectId()}`,
            rooms: [{ roomId: new Types.ObjectId(roomId), roomName: 'x', pricePerNight: 1, currency: 'EGP', adults: 1, childrenAges: [] }],
            checkInDate: dateOf(checkIn), checkOutDate: dateOf(checkIn + 1 + Math.floor(random() * 5)), totalPrice: 1, currency: 'EGP',
            status: status === 'expired-hold' ? 'Pending Payment' : status,
            holdExpiresAt: status === 'Pending Payment' ? new Date(Date.now() + 600_000) : status === 'expired-hold' ? new Date(Date.now() - 60_000) : null,
            createdAt: new Date(), updatedAt: new Date(),
          });
        }
      }
      let freeRooms = 0;
      let unavailableRooms = 0;
      for (let trial = 0; trial < 14; trial++) {
        const checkIn = 6 + Math.floor(random() * 32);
        const checkOut = checkIn + 1 + Math.floor(random() * 6);
        const q = { checkIn: day(checkIn), checkOut: day(checkOut) };
        const fromAvailable = ((await available(h.hotelId, q)).body.items as any[]).map((r) => r.id).sort();
        const statusRes = await h.moderator.agent.get(`/api/hotels/${h.hotelId}/availability`).query({ startDate: q.checkIn, endDate: q.checkOut });
        const fromStatuses = (statusRes.body as any[]).filter((r) => r.status === 'Available').map((r) => String(r.roomId)).sort();
        const searched = await search({ ...q, guests: 1 });
        // the real booking: try each room on its own; keep the table clean by cancelling what we hold
        const fromBooking: string[] = [];
        for (const roomId of h.roomIds) {
          const attempt = await holdHotel(user, { hotelId: h.hotelId, roomIds: [roomId], checkIn: q.checkIn, checkOut: q.checkOut });
          if (attempt.status === 201) { fromBooking.push(roomId); await user.agent.post(`/api/hotel-bookings/${attempt.body._id}/cancel`); }
          else expect([409]).toContain(attempt.status);
        }
        expect({ trial, rooms: fromAvailable }).toEqual({ trial, rooms: fromBooking.sort() });
        expect({ trial, rooms: fromStatuses }).toEqual({ trial, rooms: fromBooking });
        expect({ trial, found: ids(searched).length === 1 }).toEqual({ trial, found: fromBooking.length > 0 });
        if (fromBooking.length > 0) expect(searched.body.items[0].freeRooms).toBe(fromBooking.length);
        freeRooms += fromBooking.length;
        unavailableRooms += h.roomIds.length - fromBooking.length;
      }
      expect(freeRooms).toBeGreaterThan(10); // the layouts really exercised both outcomes
      expect(unavailableRooms).toBeGreaterThan(10);
    });
  });

  // ---------- rooms/available (HTL-15) ----------
  describe('HTL-15: GET /hotels/:hotelId/rooms/available', () => {
    it('a guest sees every free room with type, beds, occupancy, price per night and the total stay price', async () => {
      const h = await hotel({ roomSpecs: [{ name: 'Suite', type: 'Suite', beds: 3, maxOccupancy: 4, price: 2500 }, { name: 'Basic', type: 'Standard single', beds: 1, maxOccupancy: 1, price: 333.33 }] });
      const res = await available(h.hotelId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ hotelId: h.hotelId, checkIn: IN(), checkOut: OUT(), nights: 3 });
      expect(res.body.items).toEqual([
        { id: h.roomIds[1], name: 'Basic', type: 'Standard single', beds: 1, maxOccupancy: 1, pricePerNight: 333.33, currency: 'EGP', nights: 3, totalPrice: 999.99 },
        { id: h.roomIds[0], name: 'Suite', type: 'Suite', beds: 3, maxOccupancy: 4, pricePerNight: 2500, currency: 'EGP', nights: 3, totalPrice: 7500 },
      ]);
    });

    it('lists only the free rooms: booked, blocked, deactivated and out-of-range rooms are left out', async () => {
      const h = await hotel({ roomSpecs: [{ name: 'Free' }, { name: 'Held' }, { name: 'Blocked' }, { name: 'Off' }, { name: 'Late' }] });
      await holdRoom(await createUser(ctx), h, [h.roomIds[1]]);
      await block(h, h.roomIds[2], 11, 12);
      await h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[3]}/deactivate`);
      await setRanges(h, h.roomIds[4], [range(11, 120)]);
      expect((await available(h.hotelId)).body.items.map((r: any) => r.name)).toEqual(['Free']);
    });

    it('with nothing free it is an empty 200 with a message', async () => {
      const h = await hotel({ rooms: 1 });
      await holdRoom(await createUser(ctx), h, h.roomIds);
      expect((await available(h.hotelId)).body).toMatchObject({ items: [], message: 'No rooms available for these dates' });
    });

    it('the rooms listed are exactly what search counts as free rooms', async () => {
      const h = await hotel({ rooms: 4 });
      await holdRoom(await createUser(ctx), h, [h.roomIds[0]]);
      expect((await available(h.hotelId)).body.items).toHaveLength(3);
      expect((await search()).body.items[0].freeRooms).toBe(3);
    });

    it('an unknown or inactive hotel is 404 and a malformed id is 400', async () => {
      expect((await available('1'.repeat(24))).status).toBe(404);
      expectBadField(await available('not-an-id'), 'hotelId');
      const off = await hotel({ rooms: 1 });
      await off.admin.agent.patch(`/api/admin/providers/hotel/${off.hotelId}/deactivate`);
      expect((await available(off.hotelId)).status).toBe(404);
    });

    it('has the same date validation as search', async () => {
      const h = await hotel({ rooms: 1 });
      expectBadField(await available(h.hotelId, { checkIn: day(10), checkOut: day(10) }), 'checkOut');
      expectBadField(await available(h.hotelId, { checkIn: day(-1), checkOut: day(2) }), 'checkIn');
      expectBadField(await available(h.hotelId, { checkIn: '2026-02-30' }), 'checkIn');
      expectBadField(await available(h.hotelId, { checkOut: undefined }), 'checkOut');
      expectBadField(await available(h.hotelId, { colour: 'red' }), 'colour');
    });

    it('is public, and "search" and "available" are not mistaken for ids', async () => {
      expect((await ctx.http().get('/api/hotels/search').query({ city: 'cairo', checkIn: IN(), checkOut: OUT(), guests: 1 })).status).toBe(200);
    });

    it('HTL-02 is intact: hotel details with dates list the same rooms; without dates they list none', async () => {
      const h = await hotel({ rooms: 3 });
      await holdRoom(await createUser(ctx), h, [h.roomIds[1]]);
      const details = await ctx.http().get(`/api/hotels/${h.hotelId}`).query({ checkInDate: IN(), checkOutDate: OUT() });
      expect(details.status).toBe(200);
      expect(details.body.availableRooms.map((r: any) => String(r._id)).sort()).toEqual((await available(h.hotelId)).body.items.map((r: any) => r.id).sort());
      expect((await ctx.http().get(`/api/hotels/${h.hotelId}`)).body.availableRooms).toBeUndefined();
      expect((await ctx.http().get(`/api/hotels/${h.hotelId}`).query({ checkInDate: '2030-12-05T10:00:00Z', checkOutDate: OUT() })).status).toBe(400);
    });
  });

  // ---------- HTL-08 ----------
  describe('HTL-08: moderator room statuses', () => {
    const statuses = (h: HotelFixture, path = 'availability', q: Record<string, unknown> = {}) =>
      h.moderator.agent.get(`/api/hotels/${h.hotelId}/${path}`).query({ startDate: IN(), endDate: OUT(), ...q });

    it('each room is Available, Booked (with the reservation reference) or Blocked', async () => {
      const h = await hotel({ roomSpecs: [{ name: 'A-free' }, { name: 'B-booked' }, { name: 'C-blocked' }, { name: 'D-off' }, { name: 'E-outside' }] });
      const hold = await holdRoom(await createUser(ctx), h, [h.roomIds[1]]);
      await block(h, h.roomIds[2], 11, 12);
      await h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[3]}/deactivate`);
      await setRanges(h, h.roomIds[4], [range(11, 120)]);
      const res = await statuses(h);
      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.map((r: any) => [r.roomName, r]));
      expect(byName['A-free']).toMatchObject({ status: 'Available', reservationReference: null });
      expect(byName['B-booked']).toMatchObject({ status: 'Booked', reservationReference: hold.body.reference, reservationStatus: 'Pending Payment' });
      expect(byName['C-blocked']).toMatchObject({ status: 'Blocked', reservationReference: null });
      expect(byName['D-off']).toMatchObject({ status: 'Blocked' });
      expect(byName['E-outside']).toMatchObject({ status: 'Blocked' });
    });

    it('a Confirmed booking shows its reference and status; an expired hold is Available again', async () => {
      const h = await hotel({ roomSpecs: [{ name: 'A' }, { name: 'B' }] });
      const guest = await createUser(ctx);
      const confirmed = await holdRoom(guest, h, [h.roomIds[0]]);
      await confirmBooking(ctx, guest, 'hotel', confirmed.body._id);
      const lapsed = await holdRoom(await createUser(ctx), h, [h.roomIds[1]]);
      await ctx.conn.model('HotelBooking').updateOne({ _id: lapsed.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      const byName = Object.fromEntries((await statuses(h)).body.map((r: any) => [r.roomName, r]));
      expect(byName.A).toMatchObject({ status: 'Booked', reservationReference: confirmed.body.reference, reservationStatus: 'Confirmed' });
      expect(byName.B).toMatchObject({ status: 'Available', reservationReference: null });
    });

    it('uses the same rule as search: touching ranges are Available, a gap is Blocked', async () => {
      const h = await hotel({ roomSpecs: [{ name: 'Touch' }, { name: 'Gap' }] });
      await setRanges(h, h.roomIds[0], [range(1, 11), range(11, 120)]);
      await setRanges(h, h.roomIds[1], [range(1, 11), range(12, 120)]);
      const byName = Object.fromEntries((await statuses(h)).body.map((r: any) => [r.roomName, r.status]));
      expect(byName).toEqual({ Touch: 'Available', Gap: 'Blocked' });
    });

    it('rooms/status is the same endpoint', async () => {
      const h = await hotel({ rooms: 2 });
      expect((await statuses(h, 'rooms/status')).body).toEqual((await statuses(h)).body);
    });

    it.each([
      [{ startDate: undefined }, 'startDate'], [{ endDate: undefined }, 'endDate'],
      [{ startDate: '2026-02-30' }, 'startDate'], [{ endDate: '12/05/2030' }, 'endDate'], [{ startDate: '2030-12-05T10:00:00Z' }, 'startDate'],
      [{ startDate: day(10), endDate: day(10) }, 'endDate'], [{ startDate: day(12), endDate: day(10) }, 'endDate'], [{ colour: 'red' }, 'colour'],
    ])('a bad range %j is 400 on %s', async (q, field) => {
      const h = await hotel({ rooms: 1 });
      expectBadField(await statuses(h, 'availability', q as Record<string, unknown>), field);
    });

    it('is moderator-only and own-hotel-only: customer 403, anonymous 401, another hotel\'s moderator 403', async () => {
      const [h, other] = [await hotel({ rooms: 1 }), await hotel({ rooms: 1 })];
      const q = { startDate: IN(), endDate: OUT() };
      expect((await user.agent.get(`/api/hotels/${h.hotelId}/availability`).query(q)).status).toBe(403);
      expect((await ctx.http().get(`/api/hotels/${h.hotelId}/availability`).query(q)).status).toBe(401);
      expect((await other.moderator.agent.get(`/api/hotels/${h.hotelId}/availability`).query(q)).status).toBe(403);
    });
  });

  // ---------- HTL-04 ----------
  describe('HTL-04: non-overlapping bookable ranges', () => {
    it('overlapping ranges are 400; touching ranges are accepted', async () => {
      const h = await hotel({ rooms: 1 });
      const overlap = await setRanges(h, h.roomIds[0], [range(1, 12), range(10, 20)]);
      expect(overlap.status).toBe(400);
      expect(JSON.stringify(overlap.body.errors)).toMatch(/availabilityRanges/);
      expect((await setRanges(h, h.roomIds[0], [range(1, 11), range(11, 20)])).status).toBe(200);
      expect((await setRanges(h, h.roomIds[0], [range(1, 5), range(8, 20)])).status).toBe(200); // a gap is allowed
    });

    it('the same rule applies when a room is created with ranges', async () => {
      const h = await hotel({ rooms: 0 });
      const make = (ranges: unknown[]) => h.moderator.agent.post(`/api/hotels/${h.hotelId}/rooms`).send({ name: `R${Math.random()}`, type: 'T', beds: 1, maxOccupancy: 2, pricePerNight: 100, currency: 'EGP', availabilityRanges: ranges });
      expect((await make([range(1, 12), range(10, 20)])).status).toBe(400);
      expect((await make([range(1, 11), range(11, 20)])).status).toBe(201);
    });

    it.each([
      ['an empty list', []], ['start equal to end', [range(5, 5)]], ['end before start', [range(9, 5)]],
      ['a timestamp', [{ startDate: '2030-12-05T10:00:00Z', endDate: '2030-12-08' }]], ['a fake date', [{ startDate: '2030-02-30', endDate: '2030-03-05' }]],
      ['a malformed date', [{ startDate: '05/12/2030', endDate: '2030-12-08' }]], ['a missing end', [{ startDate: '2030-12-05' }]],
    ])('is 400: %s', async (_n, ranges) => {
      const h = await hotel({ rooms: 1 });
      expect((await setRanges(h, h.roomIds[0], ranges as never)).status).toBe(400);
    });
  });

  // ---------- HTL-05 ----------
  describe('HTL-05: editing a room', () => {
    it('beds, occupancy and price can be edited', async () => {
      const h = await hotel({ rooms: 1 });
      const res = await h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[0]}`).send({ beds: 4, maxOccupancy: 6, pricePerNight: 2750.5 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ beds: 4, maxOccupancy: 6, pricePerNight: 2750.5 });
      expect((await available(h.hotelId)).body.items[0]).toMatchObject({ beds: 4, maxOccupancy: 6, pricePerNight: 2750.5, totalPrice: 8251.5 });
    });

    it.each([['beds', 0], ['beds', 1.5], ['maxOccupancy', 0], ['pricePerNight', 0], ['pricePerNight', -5], ['pricePerNight', 'free'], ['currency', 'ZZ'], ['name', 'Renamed']])('a bad %s (%s) is 400', async (field, value) => {
      const h = await hotel({ rooms: 1 });
      expect((await h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[0]}`).send({ [field]: value })).status).toBe(400);
    });

    it('a price change does not affect an existing reservation, but applies to new ones and to search', async () => {
      const h = await hotel({ rooms: 2, pricePerNight: 1000 });
      const guest = await createUser(ctx);
      const hold = await holdRoom(guest, h, [h.roomIds[0]]);
      await confirmBooking(ctx, guest, 'hotel', hold.body._id);
      expect(hold.body.totalPrice).toBe(3000);
      await h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[0]}`).send({ pricePerNight: 5000 });
      const stored: any = await ctx.conn.model('HotelBooking').findById(hold.body._id).lean();
      expect(stored.totalPrice).toBe(3000);
      expect(stored.rooms[0].pricePerNight).toBe(1000);
      expect((await guest.agent.get(`/api/hotel-bookings/${hold.body._id}`)).body.totalPrice).toBe(3000);
      await h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[1]}`).send({ pricePerNight: 4000 });
      const fresh = await holdRoom(await createUser(ctx), h, [h.roomIds[1]]);
      expect(fresh.body.totalPrice).toBe(12000);
    });

    it('availability cannot be removed for dates with a Confirmed reservation (409), but can elsewhere', async () => {
      const h = await hotel({ rooms: 1 });
      const guest = await createUser(ctx);
      const hold = await holdRoom(guest, h, h.roomIds, day(10), day(13));
      await confirmBooking(ctx, guest, 'hotel', hold.body._id);
      expect((await setRanges(h, h.roomIds[0], [range(20, 120)])).status).toBe(409); // drops the booked nights
      expect((await setRanges(h, h.roomIds[0], [range(11, 120)])).status).toBe(409); // drops the first night
      expect((await setRanges(h, h.roomIds[0], [range(1, 12)])).status).toBe(409); // drops the last night
      expect((await setRanges(h, h.roomIds[0], [range(5, 14)])).status).toBe(200); // still covers 10-13
      expect((await setRanges(h, h.roomIds[0], [range(5, 11), range(11, 40)])).status).toBe(200); // touching ranges still cover it
      const stored: any = await ctx.conn.model('Room').findById(h.roomIds[0]).lean();
      expect(stored.availabilityRanges).toHaveLength(2);
    });

    it('an unexpired hold also protects its dates; an expired one does not', async () => {
      const h = await hotel({ rooms: 1 });
      const hold = await holdRoom(await createUser(ctx), h, h.roomIds);
      expect((await setRanges(h, h.roomIds[0], [range(30, 60)])).status).toBe(409);
      await ctx.conn.model('HotelBooking').updateOne({ _id: hold.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      expect((await setRanges(h, h.roomIds[0], [range(30, 60)])).status).toBe(200);
    });

    it('is moderator-only and own-hotel-only', async () => {
      const [h, other] = [await hotel({ rooms: 1 }), await hotel({ rooms: 1 })];
      const url = `/api/hotels/${h.hotelId}/rooms/${h.roomIds[0]}`;
      expect((await user.agent.patch(url).send({ beds: 3 })).status).toBe(403);
      expect((await other.moderator.agent.patch(url).send({ beds: 3 })).status).toBe(403);
      expect((await other.moderator.agent.patch(`${url}/availability`).send({ availabilityRanges: [range(1, 5)] })).status).toBe(403);
      expect((await ctx.http().patch(url).send({ beds: 3 })).status).toBe(401);
    });
  });

  // ---------- HTL-06 ----------
  describe('HTL-06: blocking, deactivating and deleting rooms', () => {
    const deactivate = (h: HotelFixture, i = 0) => h.moderator.agent.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[i]}/deactivate`);
    const remove = (h: HotelFixture, i = 0) => h.moderator.agent.delete(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[i]}`);

    it('blocking is rejected over a Confirmed reservation or an unexpired hold (409) and accepted elsewhere', async () => {
      const h = await hotel({ rooms: 2 });
      const guest = await createUser(ctx);
      await confirmBooking(ctx, guest, 'hotel', (await holdRoom(guest, h, [h.roomIds[0]], day(10), day(13))).body._id);
      await holdRoom(await createUser(ctx), h, [h.roomIds[1]], day(10), day(13));
      for (const i of [0, 1]) {
        expect((await block(h, h.roomIds[i], 12, 14)).status).toBe(409); // overlaps the last night
        expect((await block(h, h.roomIds[i], 9, 11)).status).toBe(409); // overlaps the first night
        expect((await block(h, h.roomIds[i], 10, 13)).status).toBe(409);
        expect((await block(h, h.roomIds[i], 13, 15)).status).toBe(200); // starts on check-out day: no overlap
      }
    });

    it('blocking over an EXPIRED hold, a Cancelled or an Expired booking is allowed', async () => {
      const h = await hotel({ rooms: 3 });
      const guest = await createUser(ctx);
      const lapsed = await holdRoom(guest, h, [h.roomIds[0]]);
      await ctx.conn.model('HotelBooking').updateOne({ _id: lapsed.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      const cancelled = await holdRoom(guest, h, [h.roomIds[1]]);
      await confirmBooking(ctx, guest, 'hotel', cancelled.body._id);
      await guest.agent.post(`/api/hotel-bookings/${cancelled.body._id}/cancel`);
      const expired = await holdRoom(guest, h, [h.roomIds[2]]);
      await guest.agent.post(`/api/hotel-bookings/${expired.body._id}/cancel`);
      for (const i of [0, 1, 2]) expect((await block(h, h.roomIds[i], 10, 13)).status).toBe(200);
    });

    it('a blocked room is excluded from search for those dates only', async () => {
      const h = await hotel({ rooms: 1 });
      await block(h, h.roomIds[0], 11, 12);
      expect(ids(await search())).toEqual([]);
      expect(ids(await search({ checkIn: day(14), checkOut: day(16) }))).toEqual([h.hotelId]);
    });

    it('deactivation is rejected while the room has a Confirmed reservation or an unexpired hold (409)', async () => {
      const h = await hotel({ rooms: 2 });
      const guest = await createUser(ctx);
      await confirmBooking(ctx, guest, 'hotel', (await holdRoom(guest, h, [h.roomIds[0]])).body._id);
      await holdRoom(await createUser(ctx), h, [h.roomIds[1]]);
      expect((await deactivate(h, 0)).status).toBe(409);
      expect((await deactivate(h, 1)).status).toBe(409);
      const stored: any[] = await ctx.conn.model('Room').find({ hotelId: h.hotelId }).lean();
      expect(stored.every((r) => r.isActive)).toBe(true);
    });

    it('a room with no reservation deactivates and then drops out of search, rooms/available and new holds', async () => {
      const h = await hotel({ rooms: 2 });
      expect((await deactivate(h, 0)).body.isActive).toBe(false);
      expect((await available(h.hotelId)).body.items.map((r: any) => r.id)).toEqual([h.roomIds[1]]);
      expect((await search()).body.items[0].freeRooms).toBe(1);
      expect((await holdRoom(await createUser(ctx), h, [h.roomIds[0]])).status).toBe(409);
    });

    it('a room whose only reservation is Cancelled, Expired or a lapsed hold can be deactivated', async () => {
      const h = await hotel({ rooms: 3 });
      const guest = await createUser(ctx);
      const lapsed = await holdRoom(guest, h, [h.roomIds[0]]);
      await ctx.conn.model('HotelBooking').updateOne({ _id: lapsed.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      const cancelled = await holdRoom(guest, h, [h.roomIds[1]]);
      await confirmBooking(ctx, guest, 'hotel', cancelled.body._id);
      await guest.agent.post(`/api/hotel-bookings/${cancelled.body._id}/cancel`);
      const expired = await holdRoom(guest, h, [h.roomIds[2]]);
      await guest.agent.post(`/api/hotel-bookings/${expired.body._id}/cancel`);
      for (const i of [0, 1, 2]) expect((await deactivate(h, i)).status).toBe(200);
    });

    it('a room that was never reserved can be deleted', async () => {
      const h = await hotel({ rooms: 2 });
      const res = await remove(h, 0);
      expect(res.status).toBe(200);
      expect(await ctx.conn.model('Room').exists({ _id: h.roomIds[0] })).toBeNull();
      expect((await available(h.hotelId)).body.items.map((r: any) => r.id)).toEqual([h.roomIds[1]]);
    });

    it('deleting a room with a CONFIRMED booking is rejected (409)', async () => {
      const h = await hotel({ rooms: 1 });
      const guest = await createUser(ctx);
      await confirmBooking(ctx, guest, 'hotel', (await holdRoom(guest, h, h.roomIds)).body._id);
      expect((await remove(h)).status).toBe(409);
      expect(await ctx.conn.model('Room').exists({ _id: h.roomIds[0] })).not.toBeNull();
    });

    it('deleting a room with a CANCELLED booking is rejected (409): history keeps pointing at the room', async () => {
      const h = await hotel({ rooms: 1 });
      const guest = await createUser(ctx);
      const hold = await holdRoom(guest, h, h.roomIds);
      await confirmBooking(ctx, guest, 'hotel', hold.body._id);
      await guest.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`);
      expect((await guest.agent.get(`/api/hotel-bookings/${hold.body._id}`)).body.status).toBe('Cancelled');
      expect((await remove(h)).status).toBe(409);
      expect(await ctx.conn.model('Room').exists({ _id: h.roomIds[0] })).not.toBeNull();
    });

    it('deleting a room with an EXPIRED booking is rejected (409): history keeps pointing at the room', async () => {
      const h = await hotel({ rooms: 1 });
      const guest = await createUser(ctx);
      const hold = await holdRoom(guest, h, h.roomIds);
      await guest.agent.post(`/api/hotel-bookings/${hold.body._id}/cancel`); // unpaid hold -> Expired
      expect((await guest.agent.get(`/api/hotel-bookings/${hold.body._id}`)).body.status).toBe('Expired');
      expect((await remove(h)).status).toBe(409);
      expect(await ctx.conn.model('Room').exists({ _id: h.roomIds[0] })).not.toBeNull();
    });

    it('deleting a room with an unexpired hold is rejected (409)', async () => {
      const h = await hotel({ rooms: 1 });
      await holdRoom(await createUser(ctx), h, h.roomIds);
      expect((await remove(h)).status).toBe(409);
    });

    it('all of it is moderator-only and own-hotel-only', async () => {
      const [h, other] = [await hotel({ rooms: 1 }), await hotel({ rooms: 1 })];
      for (const call of [
        (a: TestUser['agent']) => a.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[0]}/blocks`).send({ blockedRanges: [range(20, 22)] }),
        (a: TestUser['agent']) => a.patch(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[0]}/deactivate`),
        (a: TestUser['agent']) => a.delete(`/api/hotels/${h.hotelId}/rooms/${h.roomIds[0]}`),
      ]) {
        expect((await call(user.agent)).status).toBe(403);
        expect((await call(other.moderator.agent)).status).toBe(403);
      }
      expect(await ctx.conn.model('Room').exists({ _id: h.roomIds[0], isActive: true })).not.toBeNull();
    });

    it('Swagger documents the rules: touching ranges count as one, and why deletion keeps history', async () => {
      // the descriptions live on the controller; this guards against them being dropped
      const fs = await import('node:fs');
      const source = fs.readFileSync('src/modules/hotels/hotels.controller.ts', 'utf8');
      expect(source).toMatch(/Ranges that touch .* count as one continuous range/);
      expect(source).toMatch(/including Expired and Cancelled ones/);
    });
  });

  describe('indexes (HTL-11/12)', () => {
    it('Hotel and Room have the search indexes', async () => {
      await Promise.all([ctx.conn.model('Hotel').createIndexes(), ctx.conn.model('Room').createIndexes()]);
      const keys = async (model: string) => (await ctx.conn.model(model).collection.indexes()).map((i: any) => Object.keys(i.key).join(','));
      expect(await keys('Hotel')).toEqual(expect.arrayContaining(['isActive,cityId,averageRating', 'isActive,countryId,averageRating']));
      expect(await keys('Room')).toContain('hotelId,isActive');
      expect(await keys('HotelBooking')).toContain('rooms.roomId,status,checkInDate,checkOutDate');
    });
  });
});

// keep the helper types referenced for readers of this file
export type { RoomSpec };
