import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection, Types } from 'mongoose';

import { Airline, AirlineSchema } from '../../src/modules/airlines/schemas/airline.schema';
import { BaggagePolicy, BaggagePolicySchema } from '../../src/modules/airlines/schemas/baggage-policy.schema';
import { CancellationPolicy, CancellationPolicySchema } from '../../src/modules/airlines/schemas/cancellation-policy.schema';
import { CreateFlightBookingDto } from '../../src/modules/flight-bookings/dto/flight-bookings.dto';
import { FlightBookingsService } from '../../src/modules/flight-bookings/flight-bookings.service';
import { FlightBooking, FlightBookingSchema } from '../../src/modules/flight-bookings/schemas/flight-booking.schema';
import { CabinInventory, CabinInventorySchema } from '../../src/modules/flights/schemas/cabin-inventory.schema';
import { Flight, FlightSchema, FlightStatus } from '../../src/modules/flights/schemas/flight.schema';

/**
 * FLT-12: a round trip holds its seats on BOTH flights in one transaction, or on neither,
 * on a real replica set (transactions need one; never Atlas).
 */
describe('round-trip seat hold is atomic (FLT-12) on a real replica set', () => {
  let replSet: MongoMemoryReplSet;
  let conn: Connection;
  let flightModel: any, bookingModel: any, inventoryModel: any, airlineModel: any;
  let models: Record<string, any>;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    conn = await mongoose.createConnection(replSet.getUri()).asPromise();
    flightModel = conn.model(Flight.name, FlightSchema);
    bookingModel = conn.model(FlightBooking.name, FlightBookingSchema);
    inventoryModel = conn.model(CabinInventory.name, CabinInventorySchema);
    airlineModel = conn.model(Airline.name, AirlineSchema);
    const baggageModel = conn.model(BaggagePolicy.name, BaggagePolicySchema);
    const cancellationModel = conn.model(CancellationPolicy.name, CancellationPolicySchema);
    models = { flightModel, bookingModel, inventoryModel, airlineModel, baggageModel, cancellationModel };
    for (const m of Object.values(models)) {
      await m.createCollection();
      await m.createIndexes();
    }
  });

  afterAll(async () => {
    await conn?.close();
    await replSet?.stop();
  });

  /** The real service on the replica set; payments, countries and the currency are stubbed. */
  function service(bookings = bookingModel) {
    return new FlightBookingsService(
      bookings,
      flightModel,
      inventoryModel,
      models.cancellationModel,
      models.baggageModel,
      { expireFlightHoldsForInventory: async () => undefined } as never,
      airlineModel,
      { unknownCountryCodes: async () => [] } as never,
      { code: 'EGP' } as never,
      conn as never,
    );
  }

  /** CAI -> DXB in 30 days, DXB -> CAI in 35 days, one Economy cabin each. */
  async function trip(seats: { outbound: number; back: number }) {
    const airline = await airlineModel.create({ name: 'Nile Air', code: `N${new Types.ObjectId().toString().slice(-5)}`, isActive: true });
    const day = (n: number, h = 8) => new Date(Date.now() + n * 86_400_000 + h * 3_600_000);
    const flight = async (from: string, to: string, n: number) =>
      flightModel.create({
        flightNumber: `NA${Math.floor(Math.random() * 9000) + 1000}`, airlineId: airline._id, departureAirport: from, arrivalAirport: to,
        departureTime: day(n), arrivalTime: day(n, 12), status: FlightStatus.SCHEDULED,
      });
    const out = await flight('CAI', 'DXB', 30);
    const back = await flight('DXB', 'CAI', 35);
    const cabin = (flightId: Types.ObjectId, available: number) =>
      inventoryModel.create({ flightId, cabinClass: 'Economy', totalSeats: 10, availableSeats: available, price: 1000, currency: 'EGP', freeBagsCount: 1, maxWeightPerBagKg: 23 });
    return { out, back, outCabin: await cabin(out._id, seats.outbound), backCabin: await cabin(back._id, seats.back) };
  }

  const request = (t: { out: any; back: any }, passengers = 1): CreateFlightBookingDto => ({
    outbound: { flightId: String(t.out._id), cabinClass: 'Economy' as never },
    return: { flightId: String(t.back._id), cabinClass: 'Economy' as never },
    passengers: Array.from({ length: passengers }, (_, i) => ({ fullName: `P ${i}`, dateOfBirth: '1990-01-01', nationalId: `1234${i}`, nationality: 'EG' })),
  });
  const seats = async (cabin: any) => (await inventoryModel.findById(cabin._id).lean()).availableSeats;
  const user = () => new Types.ObjectId().toString();

  it('holds seats on both flights and creates one booking', async () => {
    const t = await trip({ outbound: 5, back: 5 });
    const booking = await service().create(user(), request(t, 2));
    expect(booking.tripType).toBe('round-trip');
    expect([await seats(t.outCabin), await seats(t.backCabin)]).toEqual([3, 3]);
    expect(await bookingModel.countDocuments({ flightId: t.out._id })).toBe(1);
  });

  it('a seat shortage on the RETURN rolls back the outbound hold: nothing is held', async () => {
    const t = await trip({ outbound: 5, back: 1 });
    await expect(service().create(user(), request(t, 2))).rejects.toMatchObject({ status: 409 });
    expect([await seats(t.outCabin), await seats(t.backCabin)]).toEqual([5, 1]);
    expect(await bookingModel.countDocuments({ flightId: t.out._id })).toBe(0);
  });

  it('a failure while creating the booking (after both holds) rolls back both holds', async () => {
    const t = await trip({ outbound: 4, back: 4 });
    const failing = Object.create(bookingModel);
    failing.create = async () => {
      throw new Error('simulated failure after the seats were taken');
    };
    await expect(service(failing).create(user(), request(t))).rejects.toThrow('simulated failure');
    expect([await seats(t.outCabin), await seats(t.backCabin)]).toEqual([4, 4]);
  });

  it('parallel round trips never oversell either flight, and seats on both flights stay in step', async () => {
    const t = await trip({ outbound: 3, back: 5 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service().create(user(), request(t))));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(3);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { status?: number }).status).toBe(409);
    expect([await seats(t.outCabin), await seats(t.backCabin)]).toEqual([0, 2]);
    expect(await bookingModel.countDocuments({ flightId: t.out._id })).toBe(3);
    expect(await bookingModel.countDocuments({ 'returnSegment.flightId': t.back._id })).toBe(3);
  });
});
