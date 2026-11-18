import { Types } from 'mongoose';
import sharp from 'sharp';

import { startApp, type E2EContext } from './helpers/app';
import { createUser, day, idOf, type TestUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

/**
 * Itineraries: derived day dates and city groups (ITN-05, ITN-09), the budget breakdown (ITN-14, ITN-18),
 * activity images (ITN-12, GEN-08), public search / detail / clone (ITN-20, ITN-21) and the hotel and
 * flight searches in an itinerary's context (ITN-25, ITN-26).
 */
describe('itineraries: days, budget, images, public view, clone and context search', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  const model = (name: string) => ctx.conn.model(name);

  async function newItinerary(user: TestUser, body: Record<string, unknown> = {}) {
    const res = await user.agent.post('/api/itineraries').send({ title: 'Trip', countryIds: ['EG', 'AE'], startDate: day(20), ...body });
    if (res.status !== 201) throw new Error(`itinerary create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return String(res.body._id);
  }
  async function addDays(user: TestUser, id: string, cities: string[]) {
    const ids: string[] = [];
    for (const cityId of cities) {
      const res = await user.agent.post(`/api/itineraries/${id}/days`).send({ cityId });
      if (res.status !== 201) throw new Error(`add day failed: ${res.status} ${JSON.stringify(res.body)}`);
      ids.push(String(res.body.days[res.body.days.length - 1]._id));
    }
    return ids;
  }
  const view = async (user: TestUser, id: string) => (await user.agent.get(`/api/itineraries/${id}`)).body;

  describe('public search and detail (ITN-20, ITN-21)', () => {
    const search = (q = '', agent: { get: (url: string) => any } = ctx.http()) => agent.get(`/api/itineraries/public/search${q}`);
    const ids = (res: any) => res.body.items.map((i: any) => i.id).sort();

    /** A public itinerary with days, an activity (with a cost), a budget entry, a transport cost and linked bookings. */
    async function publicTrip(owner: TestUser, body: Record<string, unknown> = {}, cities = ['cairo']) {
      const id = await newItinerary(owner, { visibility: 'public', ...body });
      const dayIds = await addDays(owner, id, cities);
      await owner.agent.post(`/api/itineraries/${id}/days/${dayIds[0]}/activities`).send({ name: 'Pyramids', description: 'Visit the plateau', time: '10:00', cost: 77 });
      await owner.agent.post(`/api/itineraries/${id}/days/${dayIds[0]}/budgets`).send({ description: 'Secret lunch', category: 'food', amount: 123, currency: 'EGP', type: 'actual' });
      await owner.agent.post(`/api/itineraries/${id}/transport-costs`).send({ mode: 'Train', fromCityId: 'cairo', toCityId: 'dubai', amount: 321, currency: 'EGP', dayId: dayIds[0] });
      await model('Itinerary').updateOne({ _id: id }, { $set: { hotelBookingIds: [new Types.ObjectId()], flightBookingIds: [new Types.ObjectId()] } });
      return { id, dayIds };
    }

    it('lists and shows only public itineraries; a private one is 404 for everyone, the owner included', async () => {
      const owner = await createUser(ctx);
      const other = await createUser(ctx);
      const open = await publicTrip(owner, { title: 'Open trip', countryIds: ['US'] });
      const hidden = await publicTrip(owner, { title: 'Hidden trip', countryIds: ['US'], visibility: 'private' });

      expect(ids(await search('?country=US'))).toEqual([open.id]);
      expect(ids(await search('?country=US', other.agent))).toEqual([open.id]);
      expect((await ctx.http().get(`/api/itineraries/public/${open.id}`)).status).toBe(200);
      for (const agent of [ctx.http(), other.agent, owner.agent]) {
        const res = await agent.get(`/api/itineraries/public/${hidden.id}`);
        expect(res.status).toBe(404);
      }
      expect((await ctx.http().get('/api/itineraries/public/507f1f77bcf86cd799439011')).status).toBe(404);
      expect((await ctx.http().get('/api/itineraries/public/not-an-id')).status).toBe(400);

      // Making it private again takes it out at once; the owner's own routes still work.
      expect((await owner.agent.patch(`/api/itineraries/${open.id}`).send({ visibility: 'private' })).status).toBe(200);
      expect(ids(await search('?country=US'))).toEqual([]);
      expect((await ctx.http().get(`/api/itineraries/public/${open.id}`)).status).toBe(404);
      expect((await owner.agent.get(`/api/itineraries/${open.id}`)).status).toBe(200);
    });

    it('shows no budgets, transport costs, bookings, activity costs, owner id or e-mail', async () => {
      const owner = await createUser(ctx);
      const trip = await publicTrip(owner, { title: 'Leak check', countryIds: ['DE'] });
      const detail = await ctx.http().get(`/api/itineraries/public/${trip.id}`);
      const list = await search('?country=DE');
      for (const body of [detail.body, list.body]) {
        const text = JSON.stringify(body);
        for (const secret of ['Secret lunch', 'budgets', 'transportCosts', 'hotelBookingIds', 'flightBookingIds', 'linkedBookings', 'ownerId', owner.id, owner.email, 'displayCurrency', '"cost"', '"amount"', '"currency"']) {
          expect(text).not.toContain(secret);
        }
      }
      expect(detail.body).toMatchObject({
        id: trip.id, title: 'Leak check', author: { name: owner.name },
        days: [{ dayNumber: 1, date: expect.any(String), cityId: 'cairo', activities: [{ name: 'Pyramids', description: 'Visit the plateau', time: '10:00', images: [] }] }],
        cityGroups: [{ cityId: 'cairo', dayCount: 1 }],
      });
      expect(Object.keys(detail.body.days[0].activities[0]).sort()).toEqual(['description', 'id', 'images', 'name', 'time']);
      expect(list.body.items[0]).toMatchObject({ id: trip.id, title: 'Leak check', dayCount: 1, cities: ['cairo'], author: { name: owner.name } });
    });

    it('filters by city, country and date range (an itinerary without an end date runs for its days)', async () => {
      const owner = await createUser(ctx);
      const a = await publicTrip(owner, { title: 'A', countryIds: ['JP'], startDate: day(100), endDate: day(110) }, ['tokyo']);
      const b = await publicTrip(owner, { title: 'B', countryIds: ['JP'], startDate: day(200) }, ['tokyo', 'tokyo', 'cairo']);
      const c = await publicTrip(owner, { title: 'C', countryIds: ['FR'], startDate: day(100), endDate: day(110) }, ['paris']);

      expect(ids(await search('?country=JP'))).toEqual([a.id, b.id].sort());
      expect(ids(await search('?country=jp'))).toEqual([a.id, b.id].sort());
      expect(ids(await search('?city=paris'))).toEqual([c.id]);
      expect(ids(await search('?city=cairo&country=JP'))).toEqual([b.id]);
      expect(ids(await search(`?country=JP&from=${day(105)}&to=${day(150)}`))).toEqual([a.id]);
      expect(ids(await search(`?country=JP&from=${day(111)}`))).toEqual([b.id]);
      expect(ids(await search(`?country=JP&to=${day(150)}`))).toEqual([a.id]);
      expect(ids(await search(`?country=JP&from=${day(202)}&to=${day(202)}`))).toEqual([b.id]);
      expect(ids(await search(`?country=JP&from=${day(203)}`))).toEqual([]);
      expect(ids(await search(`?country=JP&from=${day(110)}&to=${day(110)}`))).toEqual([a.id]);
      expect(ids(await search(`?country=JP&to=${day(99)}`))).toEqual([]);
      expect(ids(await search(`?city=tokyo&country=FR`))).toEqual([]);
    });

    it('400 for a bad filter, paged 10 by default, limit up to 100, no sign-in needed', async () => {
      for (const q of ['?city=a%20b', '?country=EGY', '?from=2026-13-01', '?to=tomorrow', `?from=${day(10)}&to=${day(5)}`, '?page=0', '?limit=101', '?limit=ten', '?unknown=1']) {
        const res = await search(q);
        expect({ q, status: res.status }).toEqual({ q, status: 400 });
      }
      const owner = await createUser(ctx);
      for (let i = 0; i < 12; i++) await newItinerary(owner, { title: `Page ${i}`, countryIds: ['SA'], visibility: 'public' });
      const first = await search('?country=SA');
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ page: 1, limit: 10, total: 12, pages: 2 });
      expect(first.body.items).toHaveLength(10);
      expect((await search('?country=SA&page=2')).body.items).toHaveLength(2);
      expect((await search('?country=SA&limit=100')).body.items).toHaveLength(12);
    });

    it('a deactivated author is "Deleted user"; the images of a public itinerary are public only while it is public', async () => {
      const owner = await createUser(ctx);
      const trip = await publicTrip(owner, { title: 'Pictures', countryIds: ['GB'] });
      const activityId = String(((await model('Itinerary').findById(trip.id).lean()) as any).days[0].activities[0]._id);
      const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#00aa55' } }).png().toBuffer();
      const up = await owner.agent.post(`/api/activities/${activityId}/images`).attach('file', png, { filename: 'a.png', contentType: 'image/png' });
      expect(up.status).toBe(201);

      const detail = await ctx.http().get(`/api/itineraries/public/${trip.id}`);
      const url = detail.body.days[0].activities[0].images[0].url;
      expect(url).toBe(`/api/media/public/${up.body.media.id}/content`);
      expect((await ctx.http().get(url)).status).toBe(200);

      await model('User').updateOne({ _id: owner.id }, { $set: { isActive: false, deactivatedAt: new Date() } });
      expect((await ctx.http().get(`/api/itineraries/public/${trip.id}`)).body.author).toEqual({ name: 'Deleted user' });
      expect((await search('?country=GB')).body.items[0].author).toEqual({ name: 'Deleted user' });
      await model('User').updateOne({ _id: owner.id }, { $set: { isActive: true, deactivatedAt: null } });

      await model('Itinerary').updateOne({ _id: trip.id }, { $set: { visibility: 'private' } });
      expect((await ctx.http().get(url)).status).toBe(404);
    });
  });

  describe('clone (ITN-21)', () => {
    const clone = (user: { agent: any }, id: string, body?: Record<string, unknown>) => user.agent.post(`/api/itineraries/${id}/clone`).send(body ?? {});

    /** A public itinerary: 2 days (cairo, dubai), an activity with a cost and an image, planned + actual budget, a transport cost, bookings. */
    async function original(owner: TestUser, body: Record<string, unknown> = {}) {
      const id = await newItinerary(owner, { title: 'Nile and Gulf', visibility: 'public', startDate: day(60), endDate: day(66), displayCurrency: 'EUR', ...body });
      const [d1, d2] = await addDays(owner, id, ['cairo', 'dubai']);
      await owner.agent.patch(`/api/itineraries/${id}/days/${d1}`).send({ notes: 'Start early' });
      const act = await owner.agent.post(`/api/itineraries/${id}/days/${d1}/activities`).send({ name: 'Pyramids', description: 'Visit the plateau', time: '09:30', cost: 77 });
      const activityId = String(act.body.days[0].activities[0]._id);
      const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#112233' } }).png().toBuffer();
      expect((await owner.agent.post(`/api/activities/${activityId}/images`).attach('file', png, { filename: 'a.png', contentType: 'image/png' })).status).toBe(201);
      const budget = (category: string, amount: number, type: string) =>
        owner.agent.post(`/api/itineraries/${id}/days/${d1}/budgets`).send({ description: `${category} ${type}`, category, amount, currency: 'EUR', type });
      await budget('food', 30, 'planned');
      await budget('activities', 99, 'actual');
      await owner.agent.post(`/api/itineraries/${id}/transport-costs`).send({ mode: 'Flight', fromCityId: 'cairo', toCityId: 'dubai', amount: 150, currency: 'EUR', dayId: d2 });
      await model('Itinerary').updateOne({ _id: id }, { $set: { hotelBookingIds: [new Types.ObjectId()], flightBookingIds: [new Types.ObjectId()] } });
      return { id, d1, d2, activityId };
    }

    it('copies the plan into a new PRIVATE itinerary of the caller, with attribution', async () => {
      const owner = await createUser(ctx);
      const fan = await createUser(ctx);
      const src = await original(owner);

      const res = await clone(fan, src.id);
      expect(res.status).toBe(201);
      const c = res.body;
      expect(c._id).not.toBe(src.id);
      expect(c).toMatchObject({ title: 'Nile and Gulf', visibility: 'private', ownerId: fan.id, countryIds: ['EG', 'AE'], displayCurrency: 'EUR' });
      expect(c.clonedFrom).toEqual({ itineraryId: src.id, authorName: owner.name });
      expect(c.startDate).toBe(`${day(60)}T00:00:00.000Z`);
      expect(c.endDate).toBe(`${day(66)}T00:00:00.000Z`);
      expect(c.days.map((d: any) => [d.dayNumber, d.cityId, d.date, d.notes])).toEqual([[1, 'cairo', day(60), 'Start early'], [2, 'dubai', day(61), '']]);
      expect(c.days[0].activities).toEqual([expect.objectContaining({ name: 'Pyramids', description: 'Visit the plateau', time: '09:30', images: [] })]);
      expect(c.days[0].activities[0].cost).toBeUndefined();
      expect(c.days[0].activities[0].images).toEqual([]);

      // Planned budget entries and transport costs only; the transport cost points at the clone's own day.
      expect(c.days[0].budgets.map((b: any) => [b.category, b.amount, b.type])).toEqual([['food', 30, 'planned']]);
      expect(c.budgetSummary).toMatchObject({ currency: 'EUR', plannedTotal: 180, actualTotal: 0 });
      expect(c.transportCosts).toHaveLength(1);
      expect(c.transportCosts[0]).toMatchObject({ mode: 'Flight', amount: 150, currency: 'EUR', dayId: String(c.days[1]._id) });
      expect(String(c.days[1]._id)).not.toBe(src.d2);

      // No bookings, no payments; stored separately from the original, which is untouched.
      expect(c.hotelBookingIds).toEqual([]);
      expect(c.flightBookingIds).toEqual([]);
      expect(c.linkedBookings).toEqual({ hotels: [], flights: [] });
      const stored: any = await model('Itinerary').findById(c._id).lean();
      expect(stored.days.flatMap((d: any) => d.activities.flatMap((a: any) => a.mediaIds ?? []))).toEqual([]);
      const before: any = await model('Itinerary').findById(src.id).lean();
      expect(before.hotelBookingIds).toHaveLength(1);
      expect(before.days[0].activities[0].mediaIds).toHaveLength(1);
      expect(before.days[0].budgets).toHaveLength(2);
      expect(await model('Media').countDocuments({ targetId: before.days[0].activities[0]._id })).toBe(1);

      // The clone is private: not in the public search, not readable by anyone else; editing it leaves the original alone.
      expect((await ctx.http().get(`/api/itineraries/public/${c._id}`)).status).toBe(404);
      expect((await owner.agent.get(`/api/itineraries/${c._id}`)).status).toBe(404);
      expect((await fan.agent.get(`/api/itineraries/${c._id}`)).status).toBe(200);
      expect((await fan.agent.patch(`/api/itineraries/${c._id}`).send({ title: 'My own' })).status).toBe(200);
      expect((await ctx.http().get(`/api/itineraries/public/${src.id}`)).body.title).toBe('Nile and Gulf');
    });

    it('an optional startDate moves the whole clone and keeps the end date\'s distance', async () => {
      const owner = await createUser(ctx);
      const fan = await createUser(ctx);
      const src = await original(owner);
      const res = await clone(fan, src.id, { startDate: day(200) });
      expect(res.status).toBe(201);
      expect(res.body.startDate).toBe(`${day(200)}T00:00:00.000Z`);
      expect(res.body.endDate).toBe(`${day(206)}T00:00:00.000Z`);
      expect(res.body.days.map((d: any) => d.date)).toEqual([day(200), day(201)]);
      const open = await clone(fan, await newItinerary(owner, { visibility: 'public' }), {});
      expect(open.body.endDate).toBeNull();
    });

    it("someone else's private itinerary, an unknown one and a bad id never clone; the owner may clone their own private one", async () => {
      const owner = await createUser(ctx);
      const fan = await createUser(ctx);
      const priv = await original(owner, { visibility: 'private' });
      expect((await clone(fan, priv.id)).status).toBe(404);
      expect((await clone(fan, '507f1f77bcf86cd799439011')).status).toBe(404);
      expect((await clone(fan, 'nope')).status).toBe(400);
      expect((await ctx.http().post(`/api/itineraries/${priv.id}/clone`).send({})).status).toBe(401);
      expect(await model('Itinerary').countDocuments({ ownerId: fan.id })).toBe(0);

      const own = await clone(owner, priv.id);
      expect(own.status).toBe(201);
      expect(own.body.clonedFrom).toEqual({ itineraryId: priv.id, authorName: owner.name });

      for (const body of [{ startDate: 'tomorrow' }, { startDate: '2027-13-40' }, { title: 'x' }]) {
        expect({ body, status: (await clone(fan, (await original(owner)).id, body)).status }).toEqual({ body, status: 400 });
      }
    });

    it('the attribution keeps the author name, and says "Deleted user" for a deactivated account', async () => {
      const owner = await createUser(ctx);
      const fan = await createUser(ctx);
      const src = await original(owner);
      const first = await clone(fan, src.id);
      expect(first.body.clonedFrom.authorName).toBe(owner.name);
      await model('User').updateOne({ _id: owner.id }, { $set: { isActive: false, deactivatedAt: new Date() } });
      const second = await clone(fan, src.id);
      expect(second.body.clonedFrom.authorName).toBe('Deleted user');
      expect((await fan.agent.get(`/api/itineraries/${first.body._id}`)).body.clonedFrom.authorName).toBe(owner.name);
    });
  });

  describe('activity images and upload limits (ITN-12, GEN-08)', () => {
    const png = () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#cc3300' } }).png().toBuffer();
    const jpg = () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#0033cc' } }).jpeg().toBuffer();

    async function activity(user: TestUser) {
      const id = await newItinerary(user);
      const [dayId] = await addDays(user, id, ['cairo']);
      const res = await user.agent.post(`/api/itineraries/${id}/days/${dayId}/activities`).send({ name: 'Pyramids', description: 'Visit' });
      const a = res.body.days[0].activities[0];
      return { itineraryId: id, dayId, activityId: String(a._id) };
    }
    const upload = (user: TestUser, activityId: string, buffer: Buffer, filename = 'photo.png', contentType = 'image/png') =>
      user.agent.post(`/api/activities/${activityId}/images`).attach('file', buffer, { filename, contentType });

    it('stores a PNG and a JPG; the owner sees them on the activity and can fetch the content', async () => {
      const user = await createUser(ctx);
      const a = await activity(user);
      const first = await upload(user, a.activityId, await png());
      expect(first.status).toBe(201);
      expect(first.body.media).toMatchObject({ targetType: 'activity', targetId: a.activityId, mimeType: 'image/png' });
      expect((await upload(user, a.activityId, await jpg(), 'photo.jpg', 'image/jpeg')).status).toBe(201);

      const images = (await view(user, a.itineraryId)).days[0].activities[0].images;
      expect(images).toEqual([{ id: first.body.media.id, url: `/api/media/${first.body.media.id}/content` }, expect.objectContaining({ id: expect.any(String) })]);
      const content = await user.agent.get(images[0].url);
      expect(content.status).toBe(200);
      expect(content.headers['content-type']).toMatch(/image\/png/);
      expect((await ctx.http().get(images[0].url)).status).toBe(401);
      expect((await ctx.http().get(`/api/media/public/${images[0].id}/content`)).status).toBe(404);
    });

    it('400 for a wrong type, a fake image, a corrupt file, a missing file and a file over 5 MB', async () => {
      const user = await createUser(ctx);
      const a = await activity(user);
      const text = await upload(user, a.activityId, Buffer.from('hello'), 'note.txt', 'text/plain');
      expect(text.status).toBe(400);
      const gif = await upload(user, a.activityId, await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).gif().toBuffer(), 'a.gif', 'image/gif');
      expect(gif.status).toBe(400);
      // Extension and MIME type say PNG, the bytes do not: checked by content, not by name.
      const fake = await upload(user, a.activityId, Buffer.from('<html><script>alert(1)</script></html>'), 'photo.png', 'image/png');
      expect(fake.status).toBe(400);
      const mismatch = await upload(user, a.activityId, await jpg(), 'photo.png', 'image/png');
      expect(mismatch.status).toBe(400);
      const corrupt = await upload(user, a.activityId, (await png()).subarray(0, 40), 'photo.png', 'image/png');
      expect(corrupt.status).toBe(400);
      const missing = await user.agent.post(`/api/activities/${a.activityId}/images`);
      expect(missing.status).toBe(400);
      const huge = Buffer.concat([await png(), Buffer.alloc(5 * 1024 * 1024)]);
      const big = await upload(user, a.activityId, huge);
      expect(big.status).toBe(400);
      expect(big.body.message).toMatch(/5 MB/);
      expect((await view(user, a.itineraryId)).days[0].activities[0].images).toEqual([]);
    });

    it('at most 5 images per activity: the 6th is 409, even with parallel uploads', async () => {
      const user = await createUser(ctx);
      const a = await activity(user);
      for (let i = 0; i < 5; i++) expect((await upload(user, a.activityId, await png())).status).toBe(201);
      const sixth = await upload(user, a.activityId, await png());
      expect(sixth.status).toBe(409);
      expect(await model('Media').countDocuments({ targetId: a.activityId })).toBe(5);

      const b = await activity(user);
      const results = await Promise.all(Array.from({ length: 8 }, async () => upload(user, b.activityId, await png())));
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      expect((await view(user, b.itineraryId)).days[0].activities[0].images).toHaveLength(5);
      expect(await model('Media').countDocuments({ targetId: b.activityId })).toBe(5);
    });

    it('only the owner: another user, an unknown activity and a signed-out caller never reach the activity', async () => {
      const owner = await createUser(ctx);
      const other = await createUser(ctx);
      const a = await activity(owner);
      const image = await upload(owner, a.activityId, await png());

      expect((await upload(other, a.activityId, await png())).status).toBe(404);
      expect((await upload(owner, '507f1f77bcf86cd799439011', await png())).status).toBe(404);
      expect((await upload(owner, 'not-an-id', await png())).status).toBe(400);
      expect((await ctx.http().post(`/api/activities/${a.activityId}/images`).attach('file', await png(), { filename: 'a.png', contentType: 'image/png' })).status).toBe(401);

      const url = `/api/activities/${a.activityId}/images/${image.body.media.id}`;
      expect((await other.agent.delete(url)).status).toBe(404);
      expect((await ctx.http().delete(url)).status).toBe(401);
      expect((await other.agent.get(`/api/media/${image.body.media.id}/content`)).status).toBe(404);
      expect(await model('Media').countDocuments({ targetId: a.activityId })).toBe(1);
    });

    it('DELETE removes the file, the link and the record; deleting the activity, day or itinerary removes its images', async () => {
      const user = await createUser(ctx);
      const a = await activity(user);
      const one = await upload(user, a.activityId, await png());
      const two = await upload(user, a.activityId, await png());
      const del = await user.agent.delete(`/api/activities/${a.activityId}/images/${one.body.media.id}`);
      expect(del.status).toBe(200);
      expect((await user.agent.get(`/api/media/${one.body.media.id}/content`)).status).toBe(404);
      expect((await user.agent.delete(`/api/activities/${a.activityId}/images/${one.body.media.id}`)).status).toBe(404);
      expect((await view(user, a.itineraryId)).days[0].activities[0].images.map((i: any) => i.id)).toEqual([two.body.media.id]);

      expect((await user.agent.delete(`/api/activities/${a.activityId}`)).status).toBe(200);
      expect(await model('Media').countDocuments({ targetId: a.activityId })).toBe(0);
      expect((await user.agent.get(`/api/media/${two.body.media.id}/content`)).status).toBe(404);

      const b = await activity(user);
      await upload(user, b.activityId, await png());
      expect((await user.agent.delete(`/api/itineraries/${b.itineraryId}`)).status).toBe(200);
      expect(await model('Media').countDocuments({ targetId: b.activityId })).toBe(0);
    });

    it('the same limits on the other upload routes: POST /media and POST /posts/:id/images answer 400 for a file over 5 MB', async () => {
      const user = await createUser(ctx);
      const huge = Buffer.concat([await png(), Buffer.alloc(5 * 1024 * 1024)]);
      const profile = await user.agent.post('/api/media').field('targetType', 'profile').attach('file', huge, { filename: 'a.png', contentType: 'image/png' });
      expect(profile.status).toBe(400);
      expect(profile.body.message).toMatch(/5 MB/);
      const text = await user.agent.post('/api/media').field('targetType', 'profile').attach('file', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' });
      expect(text.status).toBe(400);
      const post = await user.agent.post('/api/posts').send({ title: 'Trip', body: 'A post about a trip' });
      expect(post.status).toBe(201);
      const postId = idOf(post.body.post ?? post.body);
      const big = await user.agent.post(`/api/posts/${postId}/images`).attach('file', huge, { filename: 'a.png', contentType: 'image/png' });
      expect(big.status).toBe(400);
      expect(big.body.message).toMatch(/5 MB/);
    });
  });

  describe('budget summary: breakdown, grand total and exchange rates (ITN-14, ITN-18)', () => {
    async function budgetedItinerary(user: TestUser, displayCurrency?: string) {
      const id = await newItinerary(user, displayCurrency ? { displayCurrency } : {});
      const [d1, d2] = await addDays(user, id, ['cairo', 'dubai']);
      const entry = (dayId: string, category: string, amount: number, currency: string, type: string) =>
        user.agent.post(`/api/itineraries/${id}/days/${dayId}/budgets`).send({ description: `${category} ${amount}`, category, amount, currency, type });
      const entries = [
        await entry(d1, 'food', 100, 'EGP', 'planned'),
        await entry(d1, 'food', 10, 'EUR', 'actual'),
        await entry(d1, 'accommodation', 50, 'USD', 'planned'),
        await entry(d2, 'in_city_transport', 20, 'EUR', 'planned'),
        await entry(d2, 'activities', 300, 'EGP', 'planned'),
        await entry(d2, 'activities', 5, 'USD', 'actual'),
      ];
      for (const res of entries) expect(res.status).toBe(201);
      const cost = await user.agent.post(`/api/itineraries/${id}/transport-costs`).send({ mode: 'Flight', fromCityId: 'cairo', toCityId: 'dubai', amount: 40, currency: 'EGP', dayId: d2 });
      expect(cost.status).toBe(201);
      return id;
    }

    it('per-bucket planned and actual totals in the display currency, the grand total, and the rates used', async () => {
      const user = await createUser(ctx);
      const id = await budgetedItinerary(user, 'USD');
      const res = await user.agent.get(`/api/itineraries/${id}/budget-summary`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ itineraryId: id, currency: 'USD', plannedTotal: 80.8, actualTotal: 16 });
      expect(res.body.breakdown).toEqual({
        food: { planned: 2, actual: 11 },
        accommodation: { planned: 50, actual: 0 },
        in_city_transport: { planned: 22, actual: 0 },
        activities: { planned: 6, actual: 5 },
        intercity_transport: { planned: 0.8, actual: 0 },
      });
      expect(res.body.grandTotal).toEqual({ planned: 80.8, actual: 16 });
      expect(res.body.exchangeRates).toEqual(expect.arrayContaining([
        { from: 'EGP', to: 'USD', rate: 0.02, fetchedAt: ctx.fx.fetchedAt, stale: false },
        { from: 'EUR', to: 'USD', rate: 1.1, fetchedAt: ctx.fx.fetchedAt, stale: false },
      ]));
      expect(res.body.exchangeRates).toHaveLength(2);
      expect(res.body.ratesAsOf).toBe(ctx.fx.fetchedAt);
    });

    it('?currency= overrides the itinerary display currency; the same numbers are in GET /itineraries/:id', async () => {
      const user = await createUser(ctx);
      const id = await budgetedItinerary(user, 'USD');
      const egp = await user.agent.get(`/api/itineraries/${id}/budget-summary?currency=EGP`);
      expect(egp.status).toBe(200);
      expect(egp.body).toMatchObject({ currency: 'EGP', plannedTotal: 4040, actualTotal: 800 });
      expect(egp.body.breakdown.food).toEqual({ planned: 100, actual: 550 });
      expect(egp.body.breakdown.accommodation).toEqual({ planned: 2500, actual: 0 });
      expect(egp.body.grandTotal).toEqual({ planned: 4040, actual: 800 });
      expect(egp.body.exchangeRates.map((r: any) => r.from).sort()).toEqual(['EUR', 'USD']);

      const full = await user.agent.get(`/api/itineraries/${id}?currency=EGP`);
      expect(full.body.budgetSummary).toEqual({ currency: 'EGP', plannedTotal: 4040, actualTotal: 800, breakdown: egp.body.breakdown, grandTotal: egp.body.grandTotal, exchangeRates: egp.body.exchangeRates, ratesAsOf: egp.body.ratesAsOf });
      expect((await user.agent.get(`/api/itineraries/${id}/budget-summary?currency=ZZZ`)).status).toBe(400);
    });

    it('the grand total always equals the sum of the buckets, and nothing converted means no rate date', async () => {
      const user = await createUser(ctx);
      const id = await newItinerary(user, { displayCurrency: 'USD' });
      const [d1] = await addDays(user, id, ['cairo']);
      await user.agent.post(`/api/itineraries/${id}/days/${d1}/budgets`).send({ description: 'Hotel', category: 'accommodation', amount: 99.99, currency: 'USD', type: 'planned' });
      const res = await user.agent.get(`/api/itineraries/${id}/budget-summary`);
      expect(res.body).toMatchObject({ plannedTotal: 99.99, actualTotal: 0, exchangeRates: [], ratesAsOf: null });
      const sum = (key: 'planned' | 'actual') => Object.values(res.body.breakdown as Record<string, any>).reduce((t, b) => t + b[key], 0);
      expect(res.body.grandTotal).toEqual({ planned: Number(sum('planned').toFixed(2)), actual: Number(sum('actual').toFixed(2)) });
      expect((await (await createUser(ctx)).agent.get(`/api/itineraries/${id}/budget-summary`)).status).toBe(404);
    });
  });

  describe('day dates and city groups (ITN-05, ITN-09)', () => {
    it('a day date is derived from startDate + day order; nothing is stored and a date in the request is rejected', async () => {
      const user = await createUser(ctx);
      const id = await newItinerary(user, { startDate: day(20) });
      const [a, b, c] = await addDays(user, id, ['cairo', 'cairo', 'dubai']);
      expect((await view(user, id)).days.map((d: any) => [d.dayNumber, d.date])).toEqual([[1, day(20)], [2, day(21)], [3, day(22)]]);

      const stored: any = await model('Itinerary').findById(id).lean();
      expect(stored.days.every((d: any) => d.date === undefined)).toBe(true);

      for (const path of ['days', `days/${a}`]) {
        const send = path === 'days' ? user.agent.post(`/api/itineraries/${id}/${path}`) : user.agent.patch(`/api/itineraries/${id}/${path}`);
        const res = await send.send({ cityId: 'cairo', date: day(25) });
        expect(res.status).toBe(400);
        expect(res.body.errors.map((e: any) => e.field)).toContain('date');
      }
      void b;
      void c;
    });

    it('delete, reorder and a new startDate keep dates and numbering consistent', async () => {
      const user = await createUser(ctx);
      const id = await newItinerary(user, { startDate: day(20) });
      const [a, b, c] = await addDays(user, id, ['cairo', 'dubai', 'london']);

      await user.agent.patch(`/api/itineraries/${id}/days/reorder`).send({ dayIds: [c, a, b] });
      let v = await view(user, id);
      expect(v.days.map((d: any) => [String(d._id), d.dayNumber, d.date])).toEqual([[c, 1, day(20)], [a, 2, day(21)], [b, 3, day(22)]]);

      await user.agent.delete(`/api/itineraries/${id}/days/${a}`);
      v = await view(user, id);
      expect(v.days.map((d: any) => [String(d._id), d.dayNumber, d.date])).toEqual([[c, 1, day(20)], [b, 2, day(21)]]);

      expect((await user.agent.patch(`/api/itineraries/${id}`).send({ startDate: day(40) })).status).toBe(200);
      v = await view(user, id);
      expect(v.days.map((d: any) => d.date)).toEqual([day(40), day(41)]);
      expect(v.cityGroups.map((g: any) => [g.cityId, g.startDate, g.endDate])).toEqual([['london', day(40), day(40)], ['dubai', day(41), day(41)]]);
    });

    it('cityGroups are runs of the same city in day order; a city visited again is a new group, never an error', async () => {
      const user = await createUser(ctx);
      const id = await newItinerary(user, { startDate: day(20) });
      const ids = await addDays(user, id, ['cairo', 'cairo', 'dubai', 'cairo']);
      const v = await view(user, id);
      expect(v.cityGroups).toEqual([
        { cityId: 'cairo', startDate: day(20), endDate: day(21), dayCount: 2, dayIds: [ids[0], ids[1]] },
        { cityId: 'dubai', startDate: day(22), endDate: day(22), dayCount: 1, dayIds: [ids[2]] },
        { cityId: 'cairo', startDate: day(23), endDate: day(23), dayCount: 1, dayIds: [ids[3]] },
      ]);
      expect((await view(user, await newItinerary(user))).cityGroups).toEqual([]);
    });

    it('at most 60 days, with or without an endDate; a range over 60 days is 400', async () => {
      const user = await createUser(ctx);
      const open = await newItinerary(user, { startDate: day(20) });
      await model('Itinerary').updateOne({ _id: open }, { $set: { days: Array.from({ length: 60 }, (_, i) => ({ dayNumber: i + 1, cityId: 'cairo', notes: '' })) } });
      const full = await user.agent.post(`/api/itineraries/${open}/days`).send({ cityId: 'cairo' });
      expect(full.status).toBe(400);
      expect(full.body.message).toMatch(/at most 60 days/);
      expect((await view(user, open)).days).toHaveLength(60);
      expect((await view(user, open)).days[59].date).toBe(day(20 + 59));

      const closed = await newItinerary(user, { startDate: day(20), endDate: day(20 + 59) });
      expect(closed).toBeDefined();
      const tooLong = await user.agent.post('/api/itineraries').send({ title: 'Long', countryIds: ['EG'], startDate: day(20), endDate: day(20 + 60) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.message).toMatch(/at most 60 days/);
    });
  });
});
