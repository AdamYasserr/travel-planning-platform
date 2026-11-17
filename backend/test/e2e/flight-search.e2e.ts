import { startApp, type E2EContext } from './helpers/app';
import { holdFlight } from './helpers/bookings';
import { at, createAirline, createFlight, createUser, day, type AirlineFixture, type TestUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

/** Date n days after a YYYY-MM-DD string. */
const addDays = (date: string, n: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/** Last Sunday of a month (0-based) as YYYY-MM-DD: the UK clock-change days (March and October). */
const lastSunday = (year: number, month: number) => {
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
};
/** The next clock change in `month` that is at least 3 days away, so the test never goes stale. */
const upcomingChange = (month: number) => {
  const year = new Date().getUTCFullYear();
  for (const y of [year, year + 1, year + 2]) if (lastSunday(y, month) > day(3)) return lastSunday(y, month);
  throw new Error('unreachable');
};
/** Today's date at an airport time zone. */
const todayIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

describe('flight search and flight details (FLT-11, 12, 15, 17, 30, GEN-06)', () => {
  let ctx: E2EContext;
  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  /** Search as a guest. Every test scopes by airlineId so tests never see each other's flights. */
  const search = (q: Record<string, unknown>) => ctx.http().get('/api/flights/search').query({ origin: 'CAI', destination: 'DXB', departureDate: day(30), ...q });
  const ids = (res: any, list: 'outbound' | 'return' = 'outbound') => res.body[list].items.map((i: any) => i.id);
  const expectBadField = (res: any, field: string) => {
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: any) => e.field)).toContain(field);
  };
  /** An airline with a flight on the default CAI -> DXB day. */
  async function scene(cabins?: Parameters<typeof createFlight>[2]['cabins']) {
    const airline = await createAirline(ctx);
    const flightId = await createFlight(ctx, airline, { departure: at(30, '08:00'), arrival: at(30, '12:00'), cabins });
    return { airline, flightId, q: { airlineId: airline.airlineId } };
  }

  describe('guests can search and see the full result', () => {
    it('GET /flights/search needs no login and returns airline, airports, local and UTC times, duration, cabins and baggage', async () => {
      const { flightId, q, airline } = await scene([{ price: 1000, seats: 5, freeBags: 2, maxKg: 20 }]);
      const res = await search(q);
      expect(res.status).toBe(200);
      expect(res.body.return).toBeNull();
      expect(res.body.outbound).toMatchObject({ page: 1, limit: 10, total: 1, pages: 1 });
      const [flight] = res.body.outbound.items;
      expect(flight.id).toBe(flightId);
      expect(flight.status).toBe('Scheduled');
      expect(flight.airline).toMatchObject({ id: airline.airlineId });
      expect(flight.departure.airport).toMatchObject({ iata_code: 'CAI', city: 'Cairo', time_zone: 'Africa/Cairo' });
      expect(flight.arrival.airport).toMatchObject({ iata_code: 'DXB', city: 'Dubai', time_zone: 'Asia/Dubai' });
      expect(flight.departure.utc).toBe(at(30, '08:00'));
      expect(flight.departure.local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(flight.departure.utcOffset).toMatch(/^\+0[23]:00$/); // Cairo is +02:00, or +03:00 in summer time
      expect(flight.arrival.local.endsWith('16:00:00')).toBe(true); // 12:00Z at Dubai (+04:00)
      expect(flight.arrival.utcOffset).toBe('+04:00');
      expect(flight.durationMinutes).toBe(240);
      expect(flight.cabins).toEqual([
        { cabinClass: 'Economy', price: 1000, currency: 'EGP', seatsRemaining: 5, baggage: { freeBags: 2, maxWeightPerBagKg: 20 }, estimatedTotal: 1000 },
      ]);
    });

    it('a signed-in user gets the same result', async () => {
      const { flightId, q } = await scene();
      const user = await createUser(ctx);
      expect(ids(await user.agent.get('/api/flights/search').query({ origin: 'CAI', destination: 'DXB', departureDate: day(30), ...q }))).toEqual([flightId]);
    });

    it('no match is a 200 with an empty list and "No flights found", not an error', async () => {
      const { q } = await scene();
      const res = await search({ ...q, departureDate: day(31) });
      expect(res.status).toBe(200);
      expect(res.body.outbound).toMatchObject({ items: [], total: 0, pages: 0, message: 'No flights found' });
    });

    it('a different route does not match', async () => {
      const { q } = await scene();
      expect(ids(await search({ ...q, destination: 'LHR' }))).toEqual([]);
      expect(ids(await search({ ...q, origin: 'DXB', destination: 'CAI' }))).toEqual([]);
    });
  });

  describe('departure date is the LOCAL date at the departure airport (GEN-06)', () => {
    it('a flight leaving New York at 23:30 local is on that local day, although it is the next day in UTC', async () => {
      const airline = await createAirline(ctx);
      const flightId = await createFlight(ctx, airline, { from: 'JFK', to: 'LHR', departure: `${day(30)}T23:30:00`, arrival: `${day(31)}T12:00:00` });
      const [onLocalDay, nextDay] = await Promise.all([
        search({ origin: 'JFK', destination: 'LHR', departureDate: day(30), airlineId: airline.airlineId }),
        search({ origin: 'JFK', destination: 'LHR', departureDate: day(31), airlineId: airline.airlineId }),
      ]);
      expect(ids(onLocalDay)).toEqual([flightId]);
      expect(ids(nextDay)).toEqual([]);
      const [flight] = onLocalDay.body.outbound.items;
      expect(flight.departure.local).toBe(`${day(30)}T23:30:00`);
      expect(flight.departure.utc.slice(0, 10)).toBe(day(31));
      expect(['-05:00', '-04:00']).toContain(flight.departure.utcOffset);
    });

    it('spring DST (a 23-hour day): the local day starts and ends at the right UTC instants', async () => {
      const s = upcomingChange(2); // UK clocks go forward on this day: 00:00 GMT .. 23:00 UTC is one local day
      const airline = await createAirline(ctx);
      const mk = (time: string, label: string) => createFlight(ctx, airline, { from: 'LHR', to: 'CDG', departure: `${label}T${time}:00+00:00`, arrival: `${label}T${time}:00+00:00`.replace(/T(\d\d)/, (_m, h) => `T${String(Math.min(+h + 1, 23)).padStart(2, '0')}`) });
      const early = await mk('00:30', s); // 00:30 GMT
      const afterChange = await mk('01:30', s); // 02:30 BST
      const lateEvening = await mk('21:30', s); // 22:30 BST, still the 28th
      const justPastMidnight = await createFlight(ctx, airline, { from: 'LHR', to: 'CDG', departure: `${s}T23:15:00+00:00`, arrival: `${addDays(s, 1)}T00:30:00+00:00` }); // 00:15 BST on the NEXT local day
      const q = { origin: 'LHR', destination: 'CDG', airlineId: airline.airlineId };
      const onDay = await search({ ...q, departureDate: s });
      expect(ids(onDay).sort()).toEqual([early, afterChange, lateEvening].sort());
      expect(ids(await search({ ...q, departureDate: addDays(s, 1) }))).toEqual([justPastMidnight]);
      const late = onDay.body.outbound.items.find((i: any) => i.id === lateEvening);
      expect(late.departure).toMatchObject({ local: `${s}T22:30:00`, utcOffset: '+01:00' });
      const first = onDay.body.outbound.items.find((i: any) => i.id === early);
      expect(first.departure.utcOffset).toBe('+00:00');
    });

    it('autumn DST (a 25-hour day): flights up to 23:59 local, 25 hours after midnight, still belong to that day', async () => {
      const f = upcomingChange(9); // UK clocks go back on this day
      const airline = await createAirline(ctx);
      const first = await createFlight(ctx, airline, { from: 'LHR', to: 'CDG', departure: `${addDays(f, -1)}T23:30:00+00:00`, arrival: `${f}T00:30:00+00:00` }); // 00:30 BST on day f
      const last = await createFlight(ctx, airline, { from: 'LHR', to: 'CDG', departure: `${f}T23:30:00+00:00`, arrival: `${addDays(f, 1)}T00:30:00+00:00` }); // 23:30 GMT on day f
      const next = await createFlight(ctx, airline, { from: 'LHR', to: 'CDG', departure: `${addDays(f, 1)}T00:10:00+00:00`, arrival: `${addDays(f, 1)}T01:10:00+00:00` }); // 00:10 GMT on day f+1
      const q = { origin: 'LHR', destination: 'CDG', airlineId: airline.airlineId };
      expect(ids(await search({ ...q, departureDate: f })).sort()).toEqual([first, last].sort());
      expect(ids(await search({ ...q, departureDate: addDays(f, 1) }))).toEqual([next]);
    });

    it("\"past\" is judged by today's date at the ORIGIN airport, not the server's", async () => {
      const cairoToday = todayIn('Africa/Cairo');
      expectBadField(await search({ departureDate: addDays(cairoToday, -1) }), 'departureDate');
      expect((await search({ departureDate: cairoToday })).status).toBe(200);
      // a zone far behind UTC still has "yesterday" (in UTC) as today
      const pacific = todayIn('Pacific/Honolulu');
      expect((await search({ origin: 'JFK', destination: 'LHR', departureDate: todayIn('America/New_York') })).status).toBe(200);
      expectBadField(await search({ origin: 'JFK', destination: 'LHR', departureDate: addDays(todayIn('America/New_York'), -1) }), 'departureDate');
      expect(pacific).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('passengers (FLT-12)', () => {
    it('infants take no seat: a cabin with exactly the adult and child seats left still matches', async () => {
      const { q } = await scene([{ seats: 2 }]);
      expect((await search({ ...q, adults: 2, infants: 2 })).body.outbound.total).toBe(1);
      expect((await search({ ...q, adults: 1, children: 1, infants: 1 })).body.outbound.total).toBe(1);
    });

    it('children take a seat: 2 adults + 1 child do not fit in 2 seats', async () => {
      const { q } = await scene([{ seats: 2 }]);
      const res = await search({ ...q, adults: 2, children: 1 });
      expect(res.status).toBe(200);
      expect(res.body.outbound).toMatchObject({ total: 0, message: 'No flights found' });
    });

    it('the estimated total is (adults + children) x fare + infants x 10% of the fare', async () => {
      const { q } = await scene([{ price: 1000 }]);
      const res = await search({ ...q, adults: 2, children: 1, infants: 2 });
      expect(res.body.outbound.items[0].cabins[0].estimatedTotal).toBe(3200); // 3 x 1000 + 2 x 100
      const adultOnly = await search(q);
      expect(adultOnly.body.outbound.items[0].cabins[0].estimatedTotal).toBe(1000);
    });

    it('infants cost 10% of the fare even for fares that do not divide evenly', async () => {
      const { q } = await scene([{ price: 333.33 }]);
      const res = await search({ ...q, adults: 1, infants: 1 });
      expect(res.body.outbound.items[0].cabins[0].estimatedTotal).toBe(366.66);
    });

    it('more infants than adults is 400 on infants', async () => {
      expectBadField(await search({ adults: 1, infants: 2 }), 'infants');
      expectBadField(await search({ adults: 2, children: 3, infants: 3 }), 'infants');
    });

    it('no adult is 400 on adults', async () => {
      expectBadField(await search({ adults: 0 }), 'adults');
      expectBadField(await search({ adults: 0, children: 2 }), 'adults');
    });

    it.each([
      ['adults', 'many'], ['adults', 1.5], ['adults', 10], ['children', -1], ['children', 'x'], ['infants', -1], ['infants', 2.5],
    ])('a bad %s value (%s) is 400 on that field', async (field, value) => {
      expectBadField(await search({ [field]: value }), field);
    });
  });

  describe('cabin class, price range and sorting (FLT-12c, FLT-15)', () => {
    it('cabinClass keeps only flights with that class and shows only that cabin', async () => {
      const airline = await createAirline(ctx);
      const both = await createFlight(ctx, airline, { departure: at(30, '06:00'), arrival: at(30, '09:00'), cabins: [{ cabinClass: 'Economy', price: 1000 }, { cabinClass: 'Business', price: 4000 }] });
      await createFlight(ctx, airline, { departure: at(30, '10:00'), arrival: at(30, '13:00'), cabins: [{ cabinClass: 'Economy', price: 900 }] });
      const res = await search({ airlineId: airline.airlineId, cabinClass: 'Business' });
      expect(ids(res)).toEqual([both]);
      expect(res.body.outbound.items[0].cabins.map((c: any) => c.cabinClass)).toEqual(['Business']);
      expect((await search({ airlineId: airline.airlineId })).body.outbound.total).toBe(2);
    });

    it.each(['Economy', 'Premium Economy', 'Business', 'First'])('the cabin class "%s" is accepted', async (cabinClass) => {
      expect((await search({ cabinClass })).status).toBe(200);
    });

    it.each(['Luxury', 'economy', 'BUSINESS', 'Premium'])('an unknown cabin class "%s" is 400 on cabinClass', async (cabinClass) => {
      expectBadField(await search({ cabinClass }), 'cabinClass');
    });

    async function pricedFlights() {
      const airline = await createAirline(ctx);
      const make = (time: string, price: number) => createFlight(ctx, airline, { departure: at(30, time), arrival: at(30, `${String(+time.slice(0, 2) + 3).padStart(2, '0')}:00`), cabins: [{ price }] });
      const [cheap, mid, dear] = [await make('06:00', 1000), await make('09:00', 2000), await make('12:00', 3000)];
      return { airline, cheap, mid, dear };
    }

    it('minPrice and maxPrice are inclusive and keep the other criteria', async () => {
      const { airline, cheap, mid, dear } = await pricedFlights();
      const q = { airlineId: airline.airlineId };
      expect(ids(await search({ ...q, minPrice: 2000, maxPrice: 2000 }))).toEqual([mid]);
      expect(ids(await search({ ...q, minPrice: 1500 })).sort()).toEqual([mid, dear].sort());
      expect(ids(await search({ ...q, maxPrice: 1000 }))).toEqual([cheap]);
      expect(ids(await search({ ...q, minPrice: 1000, maxPrice: 3000 }))).toHaveLength(3);
      expect(ids(await search({ ...q, minPrice: 3000.01 }))).toEqual([]);
      // other criteria still apply: a different date gives nothing even though the price matches
      expect(ids(await search({ ...q, minPrice: 1000, departureDate: day(31) }))).toEqual([]);
    });

    it('the price range applies to the cabin: only cabins inside the range are listed', async () => {
      const airline = await createAirline(ctx);
      const flightId = await createFlight(ctx, airline, { departure: at(30, '06:00'), arrival: at(30, '09:00'), cabins: [{ cabinClass: 'Economy', price: 1000 }, { cabinClass: 'Business', price: 4000 }] });
      const res = await search({ airlineId: airline.airlineId, minPrice: 3000 });
      expect(ids(res)).toEqual([flightId]);
      expect(res.body.outbound.items[0].cabins.map((c: any) => c.cabinClass)).toEqual(['Business']);
    });

    it('minPrice greater than maxPrice is 400', async () => {
      expectBadField(await search({ minPrice: 500, maxPrice: 100 }), 'minPrice');
      expect((await search({ minPrice: 100, maxPrice: 100 })).status).toBe(200);
    });

    it.each([['minPrice', 'cheap'], ['maxPrice', 'abc'], ['minPrice', -5], ['maxPrice', '1e999'], ['minPrice', 'NaN']])('a bad %s (%s) is 400 on that field', async (field, value) => {
      expectBadField(await search({ [field]: value }), field);
    });

    it('sorts by price, duration and departure time, ascending and descending', async () => {
      const airline = await createAirline(ctx);
      // departure 06:00/09:00/12:00; price 2000/3000/1000; duration 4h/2h/3h: three different orders
      const f1 = await createFlight(ctx, airline, { departure: at(30, '06:00'), arrival: at(30, '10:00'), cabins: [{ price: 2000 }] });
      const f2 = await createFlight(ctx, airline, { departure: at(30, '09:00'), arrival: at(30, '11:00'), cabins: [{ price: 3000 }] });
      const f3 = await createFlight(ctx, airline, { departure: at(30, '12:00'), arrival: at(30, '15:00'), cabins: [{ price: 1000 }] });
      const order = async (sortBy: string, dir: string) => ids(await search({ airlineId: airline.airlineId, sortBy, order: dir }));
      expect(await order('departure', 'asc')).toEqual([f1, f2, f3]);
      expect(await order('departure', 'desc')).toEqual([f3, f2, f1]);
      expect(await order('price', 'asc')).toEqual([f3, f1, f2]);
      expect(await order('price', 'desc')).toEqual([f2, f1, f3]);
      expect(await order('duration', 'asc')).toEqual([f2, f3, f1]);
      expect(await order('duration', 'desc')).toEqual([f1, f3, f2]);
      expect(ids(await search({ airlineId: airline.airlineId }))).toEqual([f1, f2, f3]); // default: departure asc
    });

    it('sorting by price uses the cheapest matching cabin', async () => {
      const airline = await createAirline(ctx);
      const a = await createFlight(ctx, airline, { departure: at(30, '06:00'), arrival: at(30, '09:00'), cabins: [{ cabinClass: 'Economy', price: 3000 }, { cabinClass: 'Business', price: 8000 }] });
      const b = await createFlight(ctx, airline, { departure: at(30, '07:00'), arrival: at(30, '10:00'), cabins: [{ cabinClass: 'Economy', price: 2000 }] });
      expect(ids(await search({ airlineId: airline.airlineId, sortBy: 'price' }))).toEqual([b, a]);
      // only Business counts when the cabin filter is on, so the order flips
      const c = await createFlight(ctx, airline, { departure: at(30, '08:00'), arrival: at(30, '11:00'), cabins: [{ cabinClass: 'Business', price: 5000 }] });
      expect(ids(await search({ airlineId: airline.airlineId, sortBy: 'price', cabinClass: 'Business' }))).toEqual([c, a]);
    });

    it.each([['sortBy', 'cheapest'], ['sortBy', 'PRICE'], ['order', 'up'], ['order', 'ASC']])('a bad %s (%s) is 400 on that field', async (field, value) => {
      expectBadField(await search({ [field]: value }), field);
    });
  });

  describe('which flights are searchable (FLT-30, FLT-11)', () => {
    it('a deactivated airline is hidden, and visible again once reactivated', async () => {
      const { airline, flightId, q } = await scene();
      expect(ids(await search(q))).toEqual([flightId]);
      expect((await airline.admin.agent.patch(`/api/admin/providers/airline/${airline.airlineId}/deactivate`)).status).toBe(200);
      expect(ids(await search(q))).toEqual([]);
      expect((await search(q)).body.outbound.message).toBe('No flights found');
      expect((await airline.admin.agent.patch(`/api/admin/providers/airline/${airline.airlineId}/reactivate`)).status).toBe(200);
      expect(ids(await search(q))).toEqual([flightId]);
    });

    it('a Cancelled flight is hidden', async () => {
      // POST /flights/:id/cancel currently always answers 409 (FLT-06 is fail-closed until booking impact checks exist),
      // so the status is set directly.
      const { flightId, q } = await scene();
      await ctx.conn.model('Flight').updateOne({ _id: flightId }, { $set: { status: 'Cancelled' } });
      expect(ids(await search(q))).toEqual([]);
    });

    it('a Departed flight is hidden', async () => {
      const { flightId, q } = await scene();
      await ctx.conn.model('Flight').updateOne({ _id: flightId }, { $set: { status: 'Departed' } });
      expect(ids(await search(q))).toEqual([]);
    });

    it('a flight whose departure time has passed is hidden even before the status job has marked it Departed', async () => {
      const { flightId, q } = await scene();
      // One minute ago, and the search date is that instant's date in Cairo (the departure airport's zone),
      // so the test does not fail when the UTC day and the Cairo day differ (around midnight).
      const past = new Date(Date.now() - 60_000);
      await ctx.conn.model('Flight').updateOne({ _id: flightId }, { $set: { departureTime: past, arrivalTime: new Date(past.getTime() + 7200_000) } });
      const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(past);
      expect(ids(await search({ ...q, departureDate: localDay }))).toEqual([]);
    });

    it('a cabin without enough free seats is not offered; a flight with no such cabin is hidden', async () => {
      const airline = await createAirline(ctx);
      const flightId = await createFlight(ctx, airline, { departure: at(30, '06:00'), arrival: at(30, '09:00'), cabins: [{ cabinClass: 'Economy', seats: 1 }, { cabinClass: 'Business', seats: 4 }] });
      const q = { airlineId: airline.airlineId };
      const two = await search({ ...q, adults: 2 });
      expect(ids(two)).toEqual([flightId]);
      expect(two.body.outbound.items[0].cabins.map((c: any) => c.cabinClass)).toEqual(['Business']);
      expect(ids(await search({ ...q, adults: 5 }))).toEqual([]);
    });

    it('held and booked seats are subtracted: a fully held flight disappears, and returns when the hold is cancelled', async () => {
      const { flightId, q } = await scene([{ seats: 1 }]);
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      expect(hold.status).toBe(201);
      expect(ids(await search(q))).toEqual([]);
      expect((await user.agent.post(`/api/flight-bookings/${hold.body._id}/cancel`)).status).toBe(200);
      expect(ids(await search(q))).toEqual([flightId]);
    });

    it('seatsRemaining reflects holds', async () => {
      const { flightId, q } = await scene([{ seats: 5 }]);
      await holdFlight(await createUser(ctx), { flightId, passengers: 2 });
      expect((await search(q)).body.outbound.items[0].cabins[0].seatsRemaining).toBe(3);
    });
  });

  describe('round trip (FLT-12a)', () => {
    async function roundTrip() {
      const airline = await createAirline(ctx);
      const out = await createFlight(ctx, airline, { departure: at(30, '08:00'), arrival: at(30, '12:00') });
      return { airline, out, q: { airlineId: airline.airlineId, returnDate: day(30) } };
    }

    it('returns outbound and return option lists, return flights going destination -> origin', async () => {
      const airline = await createAirline(ctx);
      const out = await createFlight(ctx, airline, { departure: at(30, '08:00'), arrival: at(30, '12:00') });
      const back = await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(35, '09:00'), arrival: at(35, '12:00') });
      const wrongWay = await createFlight(ctx, airline, { from: 'CAI', to: 'DXB', departure: at(35, '10:00'), arrival: at(35, '14:00') });
      const res = await search({ airlineId: airline.airlineId, returnDate: day(35) });
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([out]);
      expect(ids(res, 'return')).toEqual([back]);
      expect(ids(res, 'return')).not.toContain(wrongWay);
      const returned = res.body.return.items[0];
      expect(returned.departure.airport.iata_code).toBe('DXB');
      expect(returned.arrival.airport.iata_code).toBe('CAI');
    });

    it('a return flight must depart after the outbound arrival', async () => {
      const { airline, out, q } = await roundTrip(); // outbound arrives 12:00Z on day 30; return on the same day
      const tooEarly = await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(30, '10:00'), arrival: at(30, '13:00') });
      const tooEarlyByAMinute = await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(30, '11:59'), arrival: at(30, '14:00') });
      const exactlyAtArrival = await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(30, '12:00'), arrival: at(30, '15:00') });
      const later = await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(30, '14:00'), arrival: at(30, '17:00') });
      const res = await search(q);
      expect(ids(res)).toEqual([out]);
      const returnIds = ids(res, 'return');
      expect(returnIds).toEqual([later]);
      for (const excluded of [tooEarly, tooEarlyByAMinute, exactlyAtArrival]) expect(returnIds).not.toContain(excluded);
    });

    it('the return date is the LOCAL date at the destination airport', async () => {
      const airline = await createAirline(ctx);
      await createFlight(ctx, airline, { departure: at(30, '08:00'), arrival: at(30, '12:00') });
      // 22:30Z on day 35 is 02:30 on day 36 in Dubai (+04:00)
      const back = await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(35, '22:30'), arrival: at(36, '01:30') });
      expect(ids(await search({ airlineId: airline.airlineId, returnDate: day(36) }), 'return')).toEqual([back]);
      expect(ids(await search({ airlineId: airline.airlineId, returnDate: day(35) }), 'return')).toEqual([]);
    });

    it('a return date before the departure date is 400 on returnDate; the same day is allowed', async () => {
      const { q } = await roundTrip();
      expectBadField(await search({ ...q, returnDate: day(29) }), 'returnDate');
      expect((await search({ ...q, returnDate: day(30) })).status).toBe(200);
    });

    it('with no outbound flights the return list is empty with "No flights found"', async () => {
      const airline = await createAirline(ctx);
      await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(35, '09:00'), arrival: at(35, '12:00') });
      const res = await search({ airlineId: airline.airlineId, returnDate: day(35) });
      expect(res.body.outbound.total).toBe(0);
      expect(res.body.return).toMatchObject({ items: [], total: 0, message: 'No flights found' });
    });

    it('the return list obeys the same passengers, cabin, price and airline filters', async () => {
      const airline = await createAirline(ctx);
      await createFlight(ctx, airline, { departure: at(30, '08:00'), arrival: at(30, '12:00'), cabins: [{ cabinClass: 'Business', price: 5000, seats: 3 }] });
      const economyOnly = await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(35, '09:00'), arrival: at(35, '12:00'), cabins: [{ cabinClass: 'Economy', price: 900 }] });
      const business = await createFlight(ctx, airline, { from: 'DXB', to: 'CAI', departure: at(35, '10:00'), arrival: at(35, '13:00'), cabins: [{ cabinClass: 'Business', price: 5200, seats: 3 }] });
      const q = { airlineId: airline.airlineId, returnDate: day(35), cabinClass: 'Business' };
      expect(ids(await search(q), 'return')).toEqual([business]);
      expect(ids(await search({ ...q, adults: 4 }), 'return')).toEqual([]);
      expect(ids(await search({ ...q, maxPrice: 5100 }), 'return')).toEqual([]);
      expect(ids(await search({ airlineId: airline.airlineId, returnDate: day(35) }), 'return').sort()).toEqual([economyOnly, business].sort());
    });

    it('a deactivated airline is hidden from the return list too', async () => {
      const airline = await createAirline(ctx);
      await createFlight(ctx, airline, { departure: at(30, '08:00'), arrival: at(30, '12:00') });
      const other = await createAirline(ctx);
      await createFlight(ctx, other, { from: 'DXB', to: 'CAI', departure: at(35, '09:00'), arrival: at(35, '12:00') });
      await other.admin.agent.patch(`/api/admin/providers/airline/${other.airlineId}/deactivate`);
      const res = await search({ returnDate: day(35), airlineId: airline.airlineId });
      expect(ids(res, 'return')).toEqual([]);
    });
  });

  describe('pagination (GEN-05)', () => {
    it('pages of 10 by default, then the rest', async () => {
      const airline = await createAirline(ctx);
      const created: string[] = [];
      for (let i = 0; i < 12; i++) {
        const hour = String(i).padStart(2, '0');
        created.push(await createFlight(ctx, airline, { departure: at(30, `${hour}:10`), arrival: at(30, `${hour}:50`) }));
      }
      const q = { airlineId: airline.airlineId };
      const first = await search(q);
      expect(first.body.outbound).toMatchObject({ page: 1, limit: 10, total: 12, pages: 2 });
      expect(first.body.outbound.items).toHaveLength(10);
      const second = await search({ ...q, page: 2 });
      expect(second.body.outbound.items).toHaveLength(2);
      expect([...ids(first), ...ids(second)]).toEqual(created); // departure ascending, no overlap
      expect((await search({ ...q, limit: 5, page: 3 })).body.outbound.items).toHaveLength(2);
    });

    it.each([['page', 0], ['page', 'two'], ['limit', 0], ['limit', 101], ['limit', 'ten']])('a bad %s (%s) is 400 on that field', async (field, value) => {
      expectBadField(await search({ [field]: value }), field);
    });
  });

  describe('strict query validation: every bad value is 400 on the right field, never an empty 200', () => {
    it.each([
      ['origin', 'CA'], ['origin', 'CAIR'], ['origin', '123'], ['origin', ''],
      ['destination', 'D'], ['destination', 'DX$'],
    ])('a malformed %s (%s) is 400 on that field', async (field, value) => {
      expectBadField(await search({ [field]: value }), field);
    });

    it('an unknown airport is 400 on that field (FLT-02: only airports from the list)', async () => {
      expectBadField(await search({ origin: 'ZZZ' }), 'origin');
      expectBadField(await search({ destination: 'QQQ' }), 'destination');
      const both = await search({ origin: 'ZZZ', destination: 'QQQ' });
      expect(both.body.errors.map((e: any) => e.field).sort()).toEqual(['destination', 'origin']);
    });

    it('lower-case airport codes are accepted', async () => {
      const { flightId, q } = await scene();
      expect(ids(await search({ ...q, origin: 'cai', destination: 'dxb' }))).toEqual([flightId]);
    });

    it('the same origin and destination is 400', async () => {
      expectBadField(await search({ origin: 'CAI', destination: 'CAI' }), 'destination');
    });

    it.each([
      ['departureDate', '2026-02-30'], ['departureDate', '2026-1-5'], ['departureDate', '05/12/2026'], ['departureDate', 'tomorrow'],
      ['departureDate', '2026-13-01'], ['departureDate', '2026-12-05T10:00:00Z'], ['returnDate', '2027-02-29'], ['returnDate', 'next week'],
    ])('a bad %s (%s) is 400 on that field', async (field, value) => {
      expectBadField(await search({ [field]: value }), field);
    });

    it.each(['origin', 'destination', 'departureDate'])('a missing %s is 400 on that field', async (field) => {
      const query: Record<string, unknown> = { origin: 'CAI', destination: 'DXB', departureDate: day(30) };
      delete query[field];
      expectBadField(await ctx.http().get('/api/flights/search').query(query), field);
    });

    it('a malformed airlineId is 400 on airlineId, an unknown but well-formed one is an empty 200', async () => {
      expectBadField(await search({ airlineId: 'nope' }), 'airlineId');
      const unknown = await search({ airlineId: '1'.repeat(24) });
      expect(unknown.status).toBe(200);
      expect(unknown.body.outbound.total).toBe(0);
    });

    it('an unknown query parameter is 400', async () => {
      expectBadField(await search({ colour: 'blue' }), 'colour');
    });

    it('several mistakes are reported together, each on its own field', async () => {
      const res = await search({ departureDate: 'soon', adults: 0, cabinClass: 'Luxury', minPrice: 'x' });
      expect(res.body.errors.map((e: any) => e.field).sort()).toEqual(['adults', 'cabinClass', 'departureDate', 'minPrice']);
    });
  });

  describe('GET /flights/:id (FLT-17)', () => {
    async function detailedFlight() {
      const airline = await createAirline(ctx);
      const flightId = await createFlight(ctx, airline, {
        departure: at(30, '08:00'), arrival: at(30, '12:00'),
        cabins: [{ cabinClass: 'Business', price: 4000, seats: 4, freeBags: 2, maxKg: 32 }, { cabinClass: 'Economy', price: 1000, seats: 8, freeBags: 1, maxKg: 23 }],
      });
      return { airline, flightId };
    }

    it('a guest sees airline, airports, local and UTC times, duration and every cabin with price, seats and baggage', async () => {
      const { airline, flightId } = await detailedFlight();
      const res = await ctx.http().get(`/api/flights/${flightId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: flightId, status: 'Scheduled', bookable: true, durationMinutes: 240 });
      expect(res.body.airline.id).toBe(airline.airlineId);
      expect(res.body.departure).toMatchObject({ utc: at(30, '08:00'), timeZone: 'Africa/Cairo' });
      expect(res.body.departure.airport.iata_code).toBe('CAI');
      expect(res.body.arrival).toMatchObject({ utc: at(30, '12:00'), timeZone: 'Asia/Dubai', utcOffset: '+04:00' });
      expect(res.body.cabins).toEqual([
        { cabinClass: 'Economy', price: 1000, currency: 'EGP', totalSeats: 8, seatsRemaining: 8, baggage: { freeBags: 1, maxWeightPerBagKg: 23 } },
        { cabinClass: 'Business', price: 4000, currency: 'EGP', totalSeats: 4, seatsRemaining: 4, baggage: { freeBags: 2, maxWeightPerBagKg: 32 } },
      ]);
    });

    it("includes the airline's cancellation policy and baggage policy, and null when they are not set", async () => {
      const { airline, flightId } = await detailedFlight();
      const none = await ctx.http().get(`/api/flights/${flightId}`);
      expect(none.body.cancellationPolicy).toBeNull();
      expect(none.body.baggagePolicy).toBeNull();

      const cancel = await airline.moderator.agent.put(`/api/airlines/${airline.airlineId}/cancellation-policy`).send({ tiers: [{ daysBeforeDeparture: 0, refundPercentage: 0 }, { daysBeforeDeparture: 7, refundPercentage: 80 }], description: 'Flexible' });
      const bag = await airline.moderator.agent.put(`/api/airlines/${airline.airlineId}/baggage-policy`).send({ carryOnAllowanceKg: 7, checkedBaggageAllowanceKg: 23, pricePerExtraBag: 150, maxExtraBagsPerPassenger: 2, currency: 'EGP' });
      expect(cancel.status).toBeLessThan(300);
      expect(bag.status).toBeLessThan(300);

      const res = await ctx.http().get(`/api/flights/${flightId}`);
      expect(res.body.cancellationPolicy).toEqual({ tiers: [{ daysBeforeDeparture: 7, refundPercentage: 80 }, { daysBeforeDeparture: 0, refundPercentage: 0 }], description: 'Flexible' });
      expect(res.body.baggagePolicy).toEqual({ carryOnAllowanceKg: 7, checkedBaggageAllowanceKg: 23, pricePerExtraBag: 150, maxExtraBagsPerPassenger: 2, currency: 'EGP' });
    });

    it('seatsRemaining follows holds', async () => {
      const { flightId } = await detailedFlight();
      await holdFlight(await createUser(ctx), { flightId, passengers: 3, cabinClass: 'Economy' });
      const economy = (await ctx.http().get(`/api/flights/${flightId}`)).body.cabins.find((c: any) => c.cabinClass === 'Economy');
      expect(economy.seatsRemaining).toBe(5);
    });

    it('a Cancelled flight can still be opened, but is not bookable', async () => {
      const { flightId } = await detailedFlight();
      await ctx.conn.model('Flight').updateOne({ _id: flightId }, { $set: { status: 'Cancelled' } });
      const res = await ctx.http().get(`/api/flights/${flightId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'Cancelled', bookable: false });
    });

    it('a flight of a deactivated airline is not bookable', async () => {
      const { airline, flightId } = await detailedFlight();
      await airline.admin.agent.patch(`/api/admin/providers/airline/${airline.airlineId}/deactivate`);
      expect((await ctx.http().get(`/api/flights/${flightId}`)).body.bookable).toBe(false);
    });

    it('an unknown id is 404 and a malformed id is 400 on id', async () => {
      expect((await ctx.http().get(`/api/flights/${'1'.repeat(24)}`)).status).toBe(404);
      expectBadField(await ctx.http().get('/api/flights/not-an-id'), 'id');
    });

    it('"search" is not read as a flight id', async () => {
      const res = await ctx.http().get('/api/flights/search').query({ origin: 'CAI', destination: 'DXB', departureDate: day(30) });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('outbound');
    });
  });

  describe('compound index (FLT-11)', () => {
    it('Flight has an index on departure airport, arrival airport, departure time, status', async () => {
      await ctx.conn.model('Flight').createIndexes();
      const indexes = await ctx.conn.model('Flight').collection.indexes();
      expect(indexes.map((i: any) => Object.keys(i.key).join(','))).toContain('departureAirport,arrivalAirport,departureTime,status');
    });
  });
});

// keep helper types referenced for readers of this file
export type { AirlineFixture, TestUser };
