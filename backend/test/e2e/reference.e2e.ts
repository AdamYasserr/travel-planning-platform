import { startApp, type E2EContext } from './helpers/app';
import { createAirlineWithFlight, createHotelWithRooms, createUser, day, unique } from './helpers/factories';
import { seedReference } from './helpers/reference';

describe('reference data, airports and currencies (GEN-12, FLT-02)', () => {
  let ctx: E2EContext;
  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  const counts = async () => ({
    countries: await ctx.conn.model('Country').countDocuments(),
    cities: await ctx.conn.model('City').countDocuments(),
    airports: await ctx.conn.model('Airport').countDocuments(),
    attractions: await ctx.conn.model('Attraction').countDocuments(),
  });

  it('seeding twice is idempotent: nothing inserted or updated the second time, same row counts', async () => {
    const before = await counts();
    const second = await seedReference(ctx);
    for (const [name, summary] of Object.entries(second.datasets)) {
      expect([name, summary.inserted, summary.updated, summary.skipped]).toEqual([name, 0, 0, 0]);
      expect(summary.unchanged).toBeGreaterThan(0);
    }
    expect(second.issues).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(before.airports).toBe(8);
  });

  it('GET /api/airports returns iata_code, name, city, country and time_zone', async () => {
    const res = await ctx.http().get('/api/airports');
    expect(res.status).toBe(200);
    const cai = res.body.items.find((a: any) => a.iata_code === 'CAI');
    expect(cai).toMatchObject({ iata_code: 'CAI', name: 'Cairo International Airport', city: 'Cairo', country: 'Egypt', time_zone: 'Africa/Cairo' });
    for (const airport of res.body.items) {
      for (const key of ['iata_code', 'name', 'city', 'country', 'time_zone']) expect(airport[key]).toEqual(expect.any(String));
    }
  });

  it('GET /api/currencies lists each supported currency once', async () => {
    const res = await ctx.http().get('/api/currencies');
    expect(res.status).toBe(200);
    const codes = JSON.stringify(res.body.items);
    for (const code of ['EGP', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'JPY']) expect(codes).toContain(code);
    const flat: string[] = res.body.items.map((i: any) => (typeof i === 'string' ? i : i.code ?? i.currency));
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('GET /api/countries, /cities and /attractions are public and use dataset ids', async () => {
    expect((await ctx.http().get('/api/countries')).body.items[0]).toHaveProperty('code');
    expect((await ctx.http().get('/api/cities?parentId=EG')).body.items.map((c: any) => c.city_id ?? c.cityId)).toContain('cairo');
    expect((await ctx.http().get('/api/attractions')).status).toBe(200);
  });

  describe('references are validated (400)', () => {
    const hotel = (over: Record<string, unknown>) => ({
      name: unique('Hotel'), address: '1 Road', cityId: 'cairo', countryId: 'EG', starClass: 3, checkInTime: '15:00', checkOutTime: '11:00', ...over,
    });

    it('a hotel in an unknown city is rejected', async () => {
      const admin = await createUser(ctx, 'admin');
      const res = await admin.agent.post('/api/hotels').send(hotel({ cityId: 'atlantis' }));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/city/i);
    });

    it('a hotel in an unknown country is rejected', async () => {
      const admin = await createUser(ctx, 'admin');
      expect((await admin.agent.post('/api/hotels').send(hotel({ countryId: 'XX' }))).status).toBe(400);
    });

    it('a hotel whose city is not in its country is rejected', async () => {
      const admin = await createUser(ctx, 'admin');
      const res = await admin.agent.post('/api/hotels').send(hotel({ cityId: 'cairo', countryId: 'FR' }));
      expect(res.status).toBe(400);
    });

    it('a hotel with a valid city and country is accepted (control)', async () => {
      const admin = await createUser(ctx, 'admin');
      expect((await admin.agent.post('/api/hotels').send(hotel({ cityId: 'paris', countryId: 'FR' }))).status).toBe(201);
    });

    it('a flight from or to an unknown airport is rejected', async () => {
      const { airlineId, moderator } = await createAirlineWithFlight(ctx);
      const depart = new Date(`${day(40)}T08:00:00.000Z`);
      const base = { flightNumber: `X${Math.floor(Math.random() * 900 + 100)}`, airlineId, departureAirport: 'CAI', arrivalAirport: 'DXB', departureTime: depart.toISOString(), arrivalTime: new Date(depart.getTime() + 4 * 3600_000).toISOString() };
      expect((await moderator.agent.post('/api/flights').send({ ...base, departureAirport: 'ZZZ' })).status).toBe(400);
      expect((await moderator.agent.post('/api/flights').send({ ...base, arrivalAirport: 'ZZZ' })).status).toBe(400);
      expect((await moderator.agent.post('/api/flights').send({ ...base, flightNumber: `Y${Math.floor(Math.random() * 900 + 100)}` })).status).toBe(201);
    });

    it('an itinerary with an unknown country is rejected', async () => {
      const user = await createUser(ctx);
      const res = await user.agent.post('/api/itineraries').send({ title: 'Trip', countryIds: ['EG', 'XX'], startDate: day(20), endDate: day(25) });
      expect(res.status).toBe(400);
    });

    it('an itinerary with an unsupported display currency is rejected', async () => {
      const user = await createUser(ctx);
      const res = await user.agent.post('/api/itineraries').send({ title: 'Trip', countryIds: ['EG'], startDate: day(20), endDate: day(25), displayCurrency: 'CAD' });
      expect(res.status).toBe(400);
    });

    it('a budget entry in an unsupported currency is rejected', async () => {
      const user = await createUser(ctx);
      const it = await user.agent.post('/api/itineraries').send({ title: 'Trip', countryIds: ['EG'], startDate: day(20), endDate: day(25) });
      const id = it.body._id ?? it.body.id;
      await user.agent.post(`/api/itineraries/${id}/days`).send({ cityId: 'cairo' });
      const stored: any = await ctx.conn.model('Itinerary').findById(id).lean();
      const res = await user.agent.post(`/api/itineraries/${id}/days/${stored.days[0]._id}/budgets`).send({ description: 'x', category: 'food', amount: 5, currency: 'CAD', type: 'planned' });
      expect(res.status).toBe(400);
    });

    it('an itinerary day in an unknown city is rejected', async () => {
      const user = await createUser(ctx);
      const it = await user.agent.post('/api/itineraries').send({ title: 'Trip', countryIds: ['EG'], startDate: day(20), endDate: day(25) });
      const res = await user.agent.post(`/api/itineraries/${it.body._id ?? it.body.id}/days`).send({ cityId: 'atlantis' });
      expect(res.status).toBe(400);
    });

    it('a hotel room in an unsupported currency is rejected', async () => {
      const { hotelId, moderator } = await createHotelWithRooms(ctx, { rooms: 0 });
      const res = await moderator.agent.post(`/api/hotels/${hotelId}/rooms`).send({ name: 'R1', type: 'Standard', beds: 1, maxOccupancy: 2, pricePerNight: 100, currency: 'CAD' });
      expect(res.status).toBe(400);
    });

    it('a user preferred currency outside the supported list is rejected', async () => {
      const user = await createUser(ctx);
      expect((await user.agent.patch('/api/users/me').send({ preferredCurrency: 'CAD' })).status).toBe(400);
    });
  });
});
