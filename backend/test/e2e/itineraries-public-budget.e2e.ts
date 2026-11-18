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
