import { Types } from 'mongoose';

import { PaymentsService } from '../../src/modules/payments/payments.service';
import { startApp, type E2EContext } from './helpers/app';
import { ETicketService } from '../../src/modules/flight-bookings/e-ticket/e-ticket.service';
import { confirmBooking, holdFlight } from './helpers/bookings';
import { at, createAirline, createAirlineWithFlight, createFlight, createUser, day } from './helpers/factories';
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

  const putBaggage = (f: { moderator: any; airlineId: string }, body: Record<string, unknown> = {}) =>
    f.moderator.agent.put(`/api/airlines/${f.airlineId}/baggage-policy`).send({
      carryOnAllowanceKg: 7, checkedBaggageAllowanceKg: 23, pricePerExtraBag: 250, maxExtraBagsPerPassenger: 2, ...body,
    });

  describe('extra baggage and the baggage currency (FLT-08)', () => {
    it('the baggage policy price must be in the platform currency: omitted means EGP, another currency is 400', async () => {
      const f = await createAirlineWithFlight(ctx);
      const usd = await putBaggage(f, { currency: 'USD' });
      expect(usd.status).toBe(400);
      expect(usd.body.errors).toEqual([{ field: 'currency', messages: ['currency must be EGP'] }]);
      const omitted = await putBaggage(f);
      expect(omitted.status).toBe(200);
      expect(omitted.body.currency).toBe('EGP');
      expect((await putBaggage(f, { currency: 'egp' })).status).toBe(200);
    });

    it('extra bags are charged per bag on top of the fare; free cabin bags stay free', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6, price: 5000 });
      await putBaggage(f);
      const user = await createUser(ctx);
      const res = await holdFlight(user, { flightId: f.flightId, body: { passengers: [pax({ extraBags: { outbound: 2 } }), pax({ fullName: 'B' })] } });
      expect(res.status).toBe(201);
      // 2 seats x 5000 + 2 extra bags x 250 = 10500
      expect(res.body.totalPrice).toBe(10500);
      expect(res.body.pricing.segments[0]).toMatchObject({ extraBags: 2, pricePerExtraBag: 250, extraBagsFee: 500, subtotal: 10500 });
      expect(res.body.passengers[0].extraBags).toEqual({ outbound: 2, return: 0 });
      expect(res.body.baggagePolicy).toMatchObject({ freeBagsCount: 1, pricePerExtraBag: 250 });
    });

    it('more than the maximum per passenger is 400 on that passenger; return bags on a one-way booking are 400', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6 });
      await putBaggage(f);
      const user = await createUser(ctx);
      const over = await holdFlight(user, { flightId: f.flightId, body: { passengers: [pax(), pax({ extraBags: { outbound: 3 } })] } });
      expect(over.status).toBe(400);
      expect(errorFields(over.body)).toEqual(['passengers.1.extraBags.outbound']);
      const back = await holdFlight(user, { flightId: f.flightId, body: { passengers: [pax({ extraBags: { return: 1 } })] } });
      expect(back.status).toBe(400);
      expect(errorFields(back.body)).toEqual(['passengers.0.extraBags.return']);
      const negative = await holdFlight(user, { flightId: f.flightId, body: { passengers: [pax({ extraBags: { outbound: -1 } })] } });
      expect(negative.status).toBe(400);
      expect(await seatsLeft(f.flightId)).toBe(6);
    });

    it('a stored policy in another currency, or no policy, refuses extra bags with 409 and holds nothing; no bags still books', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6 });
      const user = await createUser(ctx);
      const noPolicy = await holdFlight(user, { flightId: f.flightId, body: { passengers: [pax({ extraBags: { outbound: 1 } })] } });
      expect(noPolicy.status).toBe(409);
      expect(errorFields(noPolicy.body)).toEqual(['passengers.0.extraBags.outbound']);

      await putBaggage(f);
      await model('BaggagePolicy').updateOne({ airlineId: f.airlineId }, { $set: { currency: 'USD' } });
      const legacy = await holdFlight(user, { flightId: f.flightId, body: { passengers: [pax({ extraBags: { outbound: 1 } })] } });
      expect(legacy.status).toBe(409);
      expect(legacy.body.message).toMatch(/USD.*EGP/);
      expect(await seatsLeft(f.flightId)).toBe(6);
      expect((await holdFlight(user, { flightId: f.flightId })).status).toBe(201);
    });
  });

  /**
   * One airline, outbound CAI -> DXB (Economy 1500.00, Business 4000.00) and a return (default DXB -> CAI,
   * Economy 1350.50, Business 3000.00). Times are UTC on the day `n` days from today.
   */
  async function roundTrip(o: { outDay?: number; backDay?: number; outSeats?: number; backSeats?: number; backTo?: string; backDeparture?: string } = {}) {
    const airline = await createAirline(ctx);
    const outDay = o.outDay ?? 30;
    const backDay = o.backDay ?? 35;
    const outboundId = await createFlight(ctx, airline, {
      from: 'CAI', to: 'DXB', departure: at(outDay, '08:00'), arrival: at(outDay, '12:00'),
      cabins: [{ cabinClass: 'Economy', seats: o.outSeats ?? 10, price: 1500 }, { cabinClass: 'Business', seats: 4, price: 4000 }],
    });
    const backDeparture = o.backDeparture ?? at(backDay, '08:00');
    const returnId = await createFlight(ctx, airline, {
      from: 'DXB', to: o.backTo ?? 'CAI', departure: backDeparture, arrival: new Date(new Date(backDeparture).getTime() + 4 * 3_600_000).toISOString(),
      cabins: [{ cabinClass: 'Economy', seats: o.backSeats ?? 10, price: 1350.5 }, { cabinClass: 'Business', seats: 4, price: 3000 }],
    });
    return { ...airline, outboundId, returnId };
  }
  type Trip = Awaited<ReturnType<typeof roundTrip>>;
  const cabinSeats = async (flightId: string, cabinClass = 'Economy') =>
    ((await model('CabinInventory').findOne({ flightId, cabinClass }).lean()) as any).availableSeats;
  const bookRoundTrip = (user: any, t: Trip, body: Record<string, unknown> = {}) =>
    user.agent.post('/api/flight-bookings').send({
      outbound: { flightId: t.outboundId, cabinClass: 'Economy' },
      return: { flightId: t.returnId, cabinClass: 'Economy' },
      passengers: [pax()],
      policiesAccepted: true,
      ...body,
    });
  async function confirmedRoundTrip(t: Trip, body: Record<string, unknown> = {}) {
    const user = await createUser(ctx);
    const hold = await bookRoundTrip(user, t, body);
    if (hold.status !== 201) throw new Error(`round trip failed: ${hold.status} ${JSON.stringify(hold.body)}`);
    const paymentId = await confirmBooking(ctx, user, 'flight', hold.body._id);
    return { user, bookingId: String(hold.body._id), paymentId, hold };
  }

  describe('round-trip booking (FLT-12 / FLT-19)', () => {
    it('one booking, one reference, one payment, two segments; each segment priced at its own cabin; the worked example', async () => {
      const t = await roundTrip({ outDay: 30, backDay: 35 });
      await putBaggage(t, { pricePerExtraBag: 250 });
      const user = await createUser(ctx);
      const businessBack = ((await model('CabinInventory').findOne({ flightId: t.returnId, cabinClass: 'Business' }).lean()) as any)._id;
      const hold = await bookRoundTrip(user, t, {
        return: { flightId: t.returnId, cabinId: String(businessBack) },
        passengers: [
          pax({ extraBags: { outbound: 1, return: 2 } }),
          pax({ fullName: 'Omar Ali', passportNumber: undefined, passportExpiry: undefined, nationalId: '29001011234567' }),
          pax({ fullName: 'Kid', dateOfBirth: bornBefore(30, 8), extraBags: { return: 1 } }),
          pax({ fullName: 'Baby', dateOfBirth: bornBefore(30, 1) }),
        ],
      });
      expect(hold.status).toBe(201);
      // Outbound Economy: 3 x 1500 + 150 (infant) + 1 bag x 250 = 4900.
      // Return Business:  3 x 3000 + 300 (infant) + 3 bags x 250 = 10050. Total 14950.
      expect(hold.body).toMatchObject({ tripType: 'round-trip', seatCount: 3, totalPrice: 14950, cabinClass: 'Economy' });
      expect(hold.body.returnSegment).toMatchObject({ flightId: t.returnId, cabinClass: 'Business', pricePerSeat: 3000 });
      expect(hold.body.pricing.segments).toEqual([
        expect.objectContaining({ direction: 'outbound', fare: 1500, infantFare: 150, extraBags: 1, extraBagsFee: 250, subtotal: 4900 }),
        expect.objectContaining({ direction: 'return', fare: 3000, infantFare: 300, extraBags: 3, extraBagsFee: 750, subtotal: 10050 }),
      ]);
      expect(hold.body.passengers.map((p: any) => p.type)).toEqual(['adult', 'adult', 'child', 'infant']);
      expect([await cabinSeats(t.outboundId), await cabinSeats(t.returnId, 'Business')]).toEqual([7, 1]);

      const paymentId = await confirmBooking(ctx, user, 'flight', hold.body._id);
      const payments_ = await model('Payment').find({ bookingId: hold.body._id }).lean();
      expect(payments_).toHaveLength(1);
      expect(payments_[0]).toMatchObject({ amountMinor: 1495000 });
      expect(String(payments_[0]._id)).toBe(paymentId);
      expect(await model('FlightBooking').countDocuments({ reference: hold.body.reference })).toBe(1);
      expect((await bookingOf(hold.body._id)).status).toBe('Confirmed');
    });

    it('2 adults, a child and an infant with extra bags, in minor units', async () => {
      const t = await roundTrip();
      await putBaggage(t, { pricePerExtraBag: 250 });
      const user = await createUser(ctx);
      const res = await bookRoundTrip(user, t, { passengers: [
        pax({ extraBags: { outbound: 1, return: 2 } }), pax({ fullName: 'B' }), pax({ fullName: 'Kid', dateOfBirth: bornBefore(30, 8) }), pax({ fullName: 'Baby', dateOfBirth: bornBefore(30, 1) }),
      ] });
      expect(res.status).toBe(201);
      // Outbound: 3 x 1500.00 + 150.00 + 1 x 250.00 = 4900.00. Return: 3 x 1350.50 + 135.05 + 2 x 250.00 = 4686.55.
      expect(res.body.totalPrice).toBe(9586.55);
      expect(await model('FlightBooking').countDocuments({ _id: res.body._id, 'pricing.total': 9586.55 })).toBe(1);
    });

    it('the one-way request shape is unchanged, and { outbound } alone is also one-way', async () => {
      const t = await roundTrip();
      const user = await createUser(ctx);
      const legacy = await holdFlight(user, { flightId: t.outboundId });
      expect(legacy.status).toBe(201);
      expect(legacy.body).toMatchObject({ tripType: 'one-way', totalPrice: 1500 });
      expect(legacy.body.returnSegment ?? null).toBeNull();
      const outboundOnly = await bookRoundTrip(user, t, { return: undefined });
      expect(outboundOnly.status).toBe(201);
      expect(outboundOnly.body.tripType).toBe('one-way');
      expect(await cabinSeats(t.returnId)).toBe(10);
    });

    it('rejects a return that departs before (or exactly at) the outbound arrival: 409 on return.flightId, nothing held', async () => {
      const t = await roundTrip({ outDay: 30, backDeparture: at(30, '12:00') });
      const user = await createUser(ctx);
      const res = await bookRoundTrip(user, t);
      expect(res.status).toBe(409);
      expect(errorFields(res.body)).toEqual(['return.flightId']);
      expect([await cabinSeats(t.outboundId), await cabinSeats(t.returnId)]).toEqual([10, 10]);
      const earlier = await roundTrip({ outDay: 30, backDeparture: at(30, '10:00') });
      expect((await bookRoundTrip(user, earlier)).status).toBe(409);
    });

    it('rejects a return that is not the reverse route (400)', async () => {
      const t = await roundTrip({ backTo: 'LHR' });
      const res = await bookRoundTrip(await createUser(ctx), t);
      expect(res.status).toBe(400);
      expect(errorFields(res.body)).toEqual(['return.flightId']);
      expect([await cabinSeats(t.outboundId), await cabinSeats(t.returnId)]).toEqual([10, 10]);
    });

    it('a seat shortage on EITHER flight is 409 and holds nothing on both', async () => {
      const shortReturn = await roundTrip({ outSeats: 5, backSeats: 1 });
      const user = await createUser(ctx);
      const two = { passengers: [pax(), pax({ fullName: 'B' })] };
      const a = await bookRoundTrip(user, shortReturn, two);
      expect(a.status).toBe(409);
      expect(errorFields(a.body)).toEqual(['return.flightId']);
      expect([await cabinSeats(shortReturn.outboundId), await cabinSeats(shortReturn.returnId)]).toEqual([5, 1]);

      const shortOutbound = await roundTrip({ outSeats: 1, backSeats: 5 });
      const b = await bookRoundTrip(user, shortOutbound, two);
      expect(b.status).toBe(409);
      expect(errorFields(b.body)).toEqual(['outbound.flightId']);
      expect([await cabinSeats(shortOutbound.outboundId), await cabinSeats(shortOutbound.returnId)]).toEqual([1, 5]);

      // An infant needs no seat: 1 adult + 1 infant fits in the single seat left.
      const ok = await bookRoundTrip(user, shortReturn, { passengers: [pax(), pax({ fullName: 'Baby', dateOfBirth: bornBefore(30, 1) })] });
      expect(ok.status).toBe(201);
      expect([await cabinSeats(shortReturn.outboundId), await cabinSeats(shortReturn.returnId)]).toEqual([4, 0]);
    });

    it('validates the request shape and the cabins', async () => {
      const t = await roundTrip();
      const other = await roundTrip();
      const user = await createUser(ctx);
      const foreignCabin = String(((await model('CabinInventory').findOne({ flightId: other.returnId }).lean()) as any)._id);
      const cases: [Record<string, unknown>, number, string][] = [
        [{ flightId: t.outboundId, cabinClass: 'Economy' }, 400, 'outbound'],
        [{ outbound: undefined }, 400, 'outbound'],
        [{ return: { flightId: t.returnId } }, 400, 'return.cabinClass'],
        [{ return: { flightId: t.returnId, cabinClass: 'Economy', cabinId: foreignCabin } }, 400, 'return.cabinClass'],
        [{ return: { flightId: t.returnId, cabinId: foreignCabin } }, 400, 'return.cabinId'],
        [{ return: { flightId: t.returnId, cabinClass: 'First' } }, 400, 'return.cabinClass'],
        [{ return: { flightId: 'nope', cabinClass: 'Economy' } }, 400, 'return.flightId'],
        [{ return: { flightId: t.returnId, cabinClass: 'Economy', extra: 1 } }, 400, 'return.extra'],
      ];
      for (const [body, status, field] of cases) {
        const res = await bookRoundTrip(user, t, body);
        expect({ body, status: res.status }).toEqual({ body, status });
        expect(errorFields(res.body)).toContain(field);
      }
      expect((await bookRoundTrip(user, t, { return: { flightId: '507f1f77bcf86cd799439011', cabinClass: 'Economy' } })).status).toBe(404);
      expect([await cabinSeats(t.outboundId), await cabinSeats(t.returnId)]).toEqual([10, 10]);
    });

    it('passport expiry is checked against the RETURN arrival', async () => {
      const t = await roundTrip({ outDay: 30, backDay: 35 });
      const user = await createUser(ctx);
      const res = await bookRoundTrip(user, t, { passengers: [pax({ passportExpiry: day(33) })] });
      expect(res.status).toBe(400);
      expect(errorFields(res.body)).toEqual(['passengers.0.passportExpiry']);
      expect((await bookRoundTrip(user, t, { passengers: [pax({ passportExpiry: day(36) })] })).status).toBe(201);
    });

    it('cancelling uses the OUTBOUND tier and gives back the seats on both flights', async () => {
      const t = await roundTrip({ outDay: 5, backDay: 30 });
      const tiers = await t.moderator.agent.put(`/api/airlines/${t.airlineId}/cancellation-policy`).send({
        tiers: [{ daysBeforeDeparture: 20, refundPercentage: 100 }, { daysBeforeDeparture: 0, refundPercentage: 25 }],
      });
      expect(tiers.status).toBe(200);
      const { user, bookingId } = await confirmedRoundTrip(t);
      expect([await cabinSeats(t.outboundId), await cabinSeats(t.returnId)]).toEqual([9, 9]);
      const cancel = await user.agent.post(`/api/flight-bookings/${bookingId}/cancel`);
      expect(cancel.status).toBe(200);
      // 5 days before the outbound: 25%. (The return is 30 days away, which would have been 100%.)
      expect(cancel.body.refundPercentage).toBe(25);
      expect([await cabinSeats(t.outboundId), await cabinSeats(t.returnId)]).toEqual([10, 10]);
    });

    it('cannot be cancelled once the OUTBOUND has departed, but completes only after the RETURN departs', async () => {
      const t = await roundTrip({ outDay: 30, backDay: 35 });
      const { user, bookingId } = await confirmedRoundTrip(t);
      const outboundLeft = new Date(Date.now() - 60_000);
      await model('FlightBooking').updateOne({ _id: bookingId }, { $set: { departureTime: outboundLeft } });
      const cancel = await user.agent.post(`/api/flight-bookings/${bookingId}/cancel`);
      expect(cancel.status).toBe(409);
      expect(cancel.body.message).toMatch(/after departure/);

      // Between the two flights it is still "upcoming" and still Confirmed.
      const group = async (g: string) => (await user.agent.get(`/api/flight-bookings?group=${g}`)).body.items.map((b: any) => b._id);
      expect(await group('upcoming')).toEqual([bookingId]);
      expect(await group('past')).toEqual([]);
      await payments().completeFinishedBookings(new Date());
      expect((await bookingOf(bookingId)).status).toBe('Confirmed');

      const returnDeparture = (await bookingOf(bookingId)).returnSegment.departureTime as Date;
      await payments().completeFinishedBookings(new Date(returnDeparture.getTime() - 60_000));
      expect((await bookingOf(bookingId)).status).toBe('Confirmed');
      await payments().completeFinishedBookings(new Date(returnDeparture.getTime() + 60_000));
      expect((await bookingOf(bookingId)).status).toBe('Completed');
      expect(await group('past')).toEqual([bookingId]);
      expect(await group('upcoming')).toEqual([]);
    });

    it('cancelling EITHER flight (FLT-06) cancels the whole round trip with a 100% refund and frees both flights', async () => {
      for (const which of ['outboundId', 'returnId'] as const) {
        const t = await roundTrip();
        const { user, bookingId, paymentId } = await confirmedRoundTrip(t);
        const pendingUser = await createUser(ctx);
        const pending = await bookRoundTrip(pendingUser, t);
        expect([await cabinSeats(t.outboundId), await cabinSeats(t.returnId)]).toEqual([8, 8]);

        const res = await t.moderator.agent.post(`/api/flights/${t[which]}/cancel`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ cancelledBookings: 1, expiredHolds: 1, refunds: 1 });
        expect((await bookingOf(bookingId)).status).toBe('Cancelled');
        expect((await bookingOf(pending.body._id)).status).toBe('Expired');
        const refund = (await model('Refund').findOne({ paymentId }).lean()) as any;
        expect(refund).toMatchObject({ percentage: 100, status: 'Refunded' });
        const other = which === 'outboundId' ? t.returnId : t.outboundId;
        expect(await cabinSeats(other)).toBe(10);
        expect((await user.agent.get(`/api/flight-bookings/${bookingId}`)).body.status).toBe('Cancelled');
      }
    });

    it('the e-ticket (both paths) shows both flights', async () => {
      const t = await roundTrip();
      const { user, bookingId } = await confirmedRoundTrip(t);
      const data = await ctx.get(ETicketService).ticketData({ userId: user.id }, bookingId);
      const flights = await model('Flight').find({ _id: { $in: [t.outboundId, t.returnId] } }).lean();
      const number = (id: string) => (flights.find((f: any) => String(f._id) === id) as any).flightNumber;
      expect(data.flightNumber).toBe(number(t.outboundId));
      expect(data.departure.code).toBe('CAI');
      expect(data.return).toMatchObject({ flightNumber: number(t.returnId), cabinClass: 'Economy', departure: { code: 'DXB' }, arrival: { code: 'CAI' } });
      for (const path of ['bookings', 'flight-bookings']) {
        const res = await user.agent.get(`/api/${path}/${bookingId}/e-ticket`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/pdf/);
      }
    });

    it('rescheduling: copies follow the return flight; a return before the outbound arrival, or new airports, are 409', async () => {
      const t = await roundTrip({ outDay: 30, backDay: 35 });
      const { bookingId } = await confirmedRoundTrip(t);
      const patch = (flightId: string, body: Record<string, unknown>) => t.moderator.agent.patch(`/api/flights/${flightId}`).send(body);

      const later = new Date(at(36, '09:00'));
      expect((await patch(t.returnId, { departureTime: later.toISOString(), arrivalTime: new Date(later.getTime() + 4 * 3_600_000).toISOString() })).status).toBe(200);
      const moved = await bookingOf(bookingId);
      expect(moved.returnSegment.departureTime).toEqual(later);
      expect(moved.departureTime).toEqual(new Date(at(30, '08:00')));

      const tooEarly = new Date(at(30, '11:00'));
      expect((await patch(t.returnId, { departureTime: tooEarly.toISOString(), arrivalTime: new Date(tooEarly.getTime() + 4 * 3_600_000).toISOString() })).status).toBe(409);
      expect((await patch(t.outboundId, { arrivalTime: new Date(at(36, '10:00')).toISOString() })).status).toBe(409);
      expect((await patch(t.outboundId, { arrivalAirport: 'LHR' })).status).toBe(409);
      expect((await bookingOf(bookingId)).returnSegment.departureTime).toEqual(later);
      expect(((await model('Flight').findById(t.outboundId).lean()) as any).arrivalAirport).toBe('DXB');

      const outboundLater = new Date(at(31, '08:00'));
      expect((await patch(t.outboundId, { departureTime: outboundLater.toISOString(), arrivalTime: new Date(outboundLater.getTime() + 4 * 3_600_000).toISOString() })).status).toBe(200);
      const after = await bookingOf(bookingId);
      expect(after.departureTime).toEqual(outboundLater);
      expect(after.returnSegment.departureTime).toEqual(later);
    });
  });

  describe('airline view and passenger CSV (FLT-29 with FLT-12 / FLT-19)', () => {
    it('a round trip is listed on BOTH flights with that flight\'s cabin, documents, nationality and bags', async () => {
      const t = await roundTrip();
      await putBaggage(t);
      const { hold } = await confirmedRoundTrip(t, {
        return: { flightId: t.returnId, cabinClass: 'Business' },
        passengers: [
          pax({ extraBags: { outbound: 1, return: 2 } }),
          pax({ fullName: 'Baby', dateOfBirth: bornBefore(30, 1), passportNumber: undefined, passportExpiry: undefined, nationalId: '-1234', nationality: 'ae' }),
        ],
      });
      const view = async (flightId: string) =>
        ((await t.moderator.agent.get(`/api/flights/${flightId}/bookings`)).body.items as any[]).find((i) => i.bookingId === hold.body._id);
      const out = await view(t.outboundId);
      const back = await view(t.returnId);
      expect(out).toMatchObject({ tripType: 'round-trip', direction: 'outbound', cabinClass: 'Economy', passengerCounts: { adults: 1, children: 0, infants: 1 } });
      expect(back).toMatchObject({ tripType: 'round-trip', direction: 'return', cabinClass: 'Business', passengerCounts: { adults: 1, children: 0, infants: 1 } });
      expect(out.passengerDetails).toEqual([
        { fullName: 'Sara Ali', type: 'adult', passportOrId: 'A1234567', nationality: 'EG', extraBags: 1 },
        { fullName: 'Baby', type: 'infant', passportOrId: '-1234', nationality: 'AE', extraBags: 0 },
      ]);
      expect(back.passengerDetails[0].extraBags).toBe(2);

      const csv = async (flightId: string) => (await t.moderator.agent.get(`/api/flights/${flightId}/passengers/export`)).text.trimEnd().split('\r\n');
      const ref = hold.body.reference;
      expect(await csv(t.outboundId)).toEqual([
        'booking_reference,full_name,type,cabin,passport_or_id,nationality,status',
        `${ref},Sara Ali,adult,Economy,A1234567,EG,Confirmed`,
        // A value starting with "-" could run as a spreadsheet formula, so it is prefixed with '.
        `${ref},Baby,infant,Economy,'-1234,AE,Confirmed`,
      ]);
      expect((await csv(t.returnId)).slice(1)).toEqual([`${ref},Sara Ali,adult,Business,A1234567,EG,Confirmed`, `${ref},Baby,infant,Business,'-1234,AE,Confirmed`]);
    });

    it('older bookings without documents still list, with empty CSV columns', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 4 });
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId: f.flightId });
      await confirmBooking(ctx, user, 'flight', hold.body._id);
      await model('FlightBooking').collection.updateOne(
        { _id: new Types.ObjectId(String(hold.body._id)) },
        { $unset: { 'passengers.0.passportNumber': '', 'passengers.0.passportExpiry': '', 'passengers.0.nationality': '', 'passengers.0.type': '', tripType: '', seatCount: '' } },
      );
      const lines = (await f.moderator.agent.get(`/api/flights/${f.flightId}/passengers/export`)).text.trimEnd().split('\r\n');
      expect(lines[1]).toBe(`${hold.body.reference},Passenger 1,adult,Economy,,,Confirmed`);
      const item = (await f.moderator.agent.get(`/api/flights/${f.flightId}/bookings`)).body.items[0];
      expect(item).toMatchObject({ tripType: 'one-way', direction: 'outbound', passengerDetails: [{ type: 'adult', passportOrId: null, nationality: null }] });
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
