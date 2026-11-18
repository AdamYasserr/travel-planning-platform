import { startApp, type E2EContext } from './helpers/app';
import { createUser, day, type TestUser } from './helpers/factories';
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
