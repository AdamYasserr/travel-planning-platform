import { PaymentsService } from '../../src/modules/payments/payments.service';
import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdFlight } from './helpers/bookings';
import { createAirlineWithFlight, createUser, day } from './helpers/factories';
import { seedReference } from './helpers/reference';

/**
 * Round-trip booking (FLT-12 / FLT-19), passenger details and infant rules (FLT-19), extra baggage (FLT-08),
 * and the departure copy kept on bookings when a flight is rescheduled.
 */
describe('round-trip booking, passengers, extra baggage and rescheduling (FLT-12, FLT-19, FLT-08)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  const model = (name: string) => ctx.conn.model(name);
  const payments = () => ctx.get(PaymentsService);
  const bookingOf = async (id: string) => (await model('FlightBooking').findById(id).lean()) as any;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A passenger with valid travel documents; override any field. */
  const pax = (over: Record<string, unknown> = {}) => ({
    fullName: 'Sara Ali', dateOfBirth: '1990-04-02', passportNumber: 'A1234567', passportExpiry: '2045-01-01', nationality: 'EG', ...over,
  });
  /** Born `years` years (and a month) before the departure day `departDay` days from now. */
  const bornBefore = (departDay: number, years: number) => {
    const d = new Date(`${day(departDay)}T00:00:00.000Z`);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 10);
  };
  const seatsLeft = async (flightId: string) => ((await model('CabinInventory').findOne({ flightId }).lean()) as any).availableSeats;
  const errorFields = (body: any) => (body.errors ?? []).map((e: any) => e.field);

  describe('passengers, types and pricing on a one-way booking (FLT-19)', () => {
    it('the one-way request shape still works: one booking, one reference, seats and total as before for adults', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6, price: 5000 });
      const user = await createUser(ctx);
      const res = await user.agent.post('/api/flight-bookings').send({
        flightId: f.flightId, cabinClass: 'Economy', policiesAccepted: true, passengers: [pax(), pax({ fullName: 'Omar Ali', passportNumber: undefined, passportExpiry: undefined, nationalId: '29001011234567' })],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'Pending Payment', seatCount: 2, totalPrice: 10000, pricePerSeat: 5000, currency: 'EGP' });
      expect(res.body.reference).toMatch(/^FLT-/);
      expect(res.body.passengers).toEqual([
        expect.objectContaining({ type: 'adult', passportNumber: 'A1234567', nationality: 'EG' }),
        expect.objectContaining({ type: 'adult', nationalId: '29001011234567', nationality: 'EG' }),
      ]);
      expect(await seatsLeft(f.flightId)).toBe(4);
    });

    it('derives adult / child / infant from the date of birth on the departure day; the infant takes no seat and pays 10%', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6, price: 1350.5, departInDays: 30 });
      const user = await createUser(ctx);
      const res = await holdFlight(user, { flightId: f.flightId, body: { passengers: [
        pax(), pax({ fullName: 'Kid', dateOfBirth: bornBefore(30, 8) }), pax({ fullName: 'Baby', dateOfBirth: bornBefore(30, 1) }),
      ] } });
      expect(res.status).toBe(201);
      expect(res.body.passengers.map((p: any) => p.type)).toEqual(['adult', 'child', 'infant']);
      // 2 seats x 1350.50 + 10% of 1350.50 (135.05) = 2836.05
      expect(res.body).toMatchObject({ seatCount: 2, totalPrice: 2836.05 });
      expect(res.body.pricing).toMatchObject({ total: 2836.05, segments: [{ direction: 'outbound', fare: 1350.5, infantFare: 135.05, seats: 2, infants: 1, subtotal: 2836.05 }] });
      expect(await seatsLeft(f.flightId)).toBe(4);

      // Expiring the hold gives back exactly the 2 seats.
      await model('FlightBooking').updateOne({ _id: res.body._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      await payments().expirePendingBookings();
      expect(await seatsLeft(f.flightId)).toBe(6);
    });

    it('a booking whose passengers are all infants needs no seat but is rejected: at least one adult', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6 });
      const user = await createUser(ctx);
      const noAdult = await holdFlight(user, { flightId: f.flightId, body: { passengers: [pax({ dateOfBirth: bornBefore(30, 8) })] } });
      expect(noAdult.status).toBe(400);
      expect(errorFields(noAdult.body)).toEqual(['passengers']);
      const infants = await holdFlight(user, { flightId: f.flightId, body: { passengers: [pax(), pax({ dateOfBirth: bornBefore(30, 1) }), pax({ dateOfBirth: bornBefore(30, 1) })] } });
      expect(infants.status).toBe(400);
      expect(infants.body.errors[0].messages[0]).toMatch(/infant/i);
      const tooMany = await holdFlight(user, { flightId: f.flightId, body: { passengers: Array.from({ length: 10 }, () => pax()) } });
      expect(tooMany.status).toBe(400);
      expect(await seatsLeft(f.flightId)).toBe(6);
    });

    it('passport or national ID: exactly one, valid formats, passport expiry after arrival, known nationality', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6, departInDays: 30 });
      const user = await createUser(ctx);
      const hold = (p: Record<string, unknown>) => holdFlight(user, { flightId: f.flightId, body: { passengers: [p] } });
      const cases: [Record<string, unknown>, string][] = [
        [pax({ passportNumber: undefined, passportExpiry: undefined }), 'passengers.0.passportNumber'],
        [pax({ nationalId: '29001011234567' }), 'passengers.0.nationalId'],
        [pax({ passportNumber: 'AB12' }), 'passengers.0.passportNumber'],
        [pax({ passportNumber: 'AB12-4567' }), 'passengers.0.passportNumber'],
        [pax({ passportExpiry: undefined }), 'passengers.0.passportExpiry'],
        [pax({ passportExpiry: day(30) }), 'passengers.0.passportExpiry'],
        [pax({ passportExpiry: '2045-02-30' }), 'passengers.0.passportExpiry'],
        [pax({ passportNumber: undefined, nationalId: '2900101' }), 'passengers.0.passportExpiry'],
        [pax({ nationality: 'XX' }), 'passengers.0.nationality'],
        [pax({ nationality: undefined }), 'passengers.0.nationality'],
        [pax({ type: 'adult' }), 'passengers.0.type'],
      ];
      for (const [p, field] of cases) {
        const res = await hold(p);
        expect({ p, status: res.status }).toEqual({ p, status: 400 });
        expect(errorFields(res.body)).toContain(field);
      }
      expect((await hold(pax({ passportExpiry: day(31) }))).status).toBe(201);
      expect(await seatsLeft(f.flightId)).toBe(5);
    });

    it('a flight of an inactive airline cannot be booked (409); an unknown flight is 404', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6 });
      const user = await createUser(ctx);
      await model('Airline').updateOne({ _id: f.airlineId }, { $set: { isActive: false } });
      const res = await holdFlight(user, { flightId: f.flightId });
      expect(res.status).toBe(409);
      expect(errorFields(res.body)).toEqual(['flightId']);
      expect((await holdFlight(user, { flightId: '507f1f77bcf86cd799439011' })).status).toBe(404);
      await model('Airline').updateOne({ _id: f.airlineId }, { $set: { isActive: true } });
      const noCabin = await holdFlight(user, { flightId: f.flightId, cabinClass: 'First' });
      expect(noCabin.status).toBe(400);
      expect(errorFields(noCabin.body)).toEqual(['cabinClass']);
      expect(await seatsLeft(f.flightId)).toBe(6);
    });
  });

  describe('rescheduling a flight updates the departure copy on its bookings', () => {
    async function confirmedOn(flightId: string) {
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      if (hold.status !== 201) throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.body)}`);
      await confirmBooking(ctx, user, 'flight', hold.body._id);
      return { user, bookingId: String(hold.body._id) };
    }
    const reschedule = (f: { moderator: any; flightId: string }, depart: Date) =>
      f.moderator.agent.patch(`/api/flights/${f.flightId}`).send({
        departureTime: depart.toISOString(),
        arrivalTime: new Date(depart.getTime() + 4 * 3_600_000).toISOString(),
      });

    it('copies the new departure onto Pending and Confirmed bookings, but not onto final ones', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6, departInDays: 30 });
      const confirmed = await confirmedOn(f.flightId);
      const pending = await holdFlight(await createUser(ctx), { flightId: f.flightId });
      const cancelled = await confirmedOn(f.flightId);
      await model('FlightBooking').updateOne({ _id: cancelled.bookingId }, { $set: { status: 'Cancelled' } });

      const depart = new Date(`${day(31)}T09:15:00.000Z`);
      expect((await reschedule(f, depart)).status).toBe(200);
      expect((await bookingOf(confirmed.bookingId)).departureTime).toEqual(depart);
      expect((await bookingOf(pending.body._id)).departureTime).toEqual(depart);
      expect((await bookingOf(cancelled.bookingId)).departureTime).toEqual(new Date(`${day(30)}T08:00:00.000Z`));
    });

    it('a rescheduled flight cannot be cancelled after its NEW departure', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 4, departInDays: 30 });
      const { user, bookingId } = await confirmedOn(f.flightId);
      expect((await reschedule(f, new Date(Date.now() + 2_500))).status).toBe(200);
      await sleep(3_000);
      const res = await user.agent.post(`/api/flight-bookings/${bookingId}/cancel`);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/after departure/);
    });

    it('completes at the NEW departure: not early when moved later, not late when moved earlier', async () => {
      const later = await createAirlineWithFlight(ctx, { seats: 4, departInDays: 40 });
      const earlier = await createAirlineWithFlight(ctx, { seats: 4, departInDays: 40 });
      const a = await confirmedOn(later.flightId);
      const b = await confirmedOn(earlier.flightId);
      const laterDepart = new Date(`${day(41)}T08:00:00.000Z`);
      const earlierDepart = new Date(`${day(39)}T08:00:00.000Z`);
      expect((await reschedule(later, laterDepart)).status).toBe(200);
      expect((await reschedule(earlier, earlierDepart)).status).toBe(200);

      await payments().completeFinishedBookings(new Date(earlierDepart.getTime() + 60_000));
      expect((await bookingOf(b.bookingId)).status).toBe('Completed');
      expect((await bookingOf(a.bookingId)).status).toBe('Confirmed');

      await payments().completeFinishedBookings(new Date(`${day(40)}T09:00:00.000Z`));
      expect((await bookingOf(a.bookingId)).status).toBe('Confirmed');

      await payments().completeFinishedBookings(new Date(laterDepart.getTime() + 60_000));
      expect((await bookingOf(a.bookingId)).status).toBe('Completed');
    });
  });
});
