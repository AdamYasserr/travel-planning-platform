import type { INestApplicationContext } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';

import { AuthService } from '../../../auth/auth.service';
import { assertBookingTransition, BOOKING_STATUS } from '../../../common/booking/booking-status';
import { PlatformCurrencyService } from '../../../common/currency/platform-currency.service';
import { UserRole } from '../../../common/enums/user-role.enum';
import { AirlinesService } from '../../../modules/airlines/airlines.service';
import { FlightBookingsService } from '../../../modules/flight-bookings/flight-bookings.service';
import { CabinInventoryService } from '../../../modules/flights/cabin-inventory.service';
import { FlightsService } from '../../../modules/flights/flights.service';
import { HotelBookingsService } from '../../../modules/hotel-bookings/hotel-bookings.service';
import { HotelsService } from '../../../modules/hotels/hotels.service';
import { ItinerariesService } from '../../../modules/itineraries/itineraries.service';
import { PaymentBookingType } from '../../../modules/payments/enums/payment-status.enum';
import { PaymentsService } from '../../../modules/payments/payments.service';
import {
  SEED_AIRLINE,
  SEED_FLIGHT_NUMBERS,
  SEED_HOTEL_NAME,
  SEED_USERS,
  SeedUserKey,
} from './demo-seed.constants';
import { installLocalStripe, succeededEvent } from './local-stripe';
import { SeedManifest } from './seed-manifest';

const DAY_MS = 86_400_000;

export interface DemoSeedSummary {
  currency: string;
  route: { from: AirportRef; to: AirportRef };
  users: { key: SeedUserKey; name: string; email: string; role: string; id: string }[];
  airlineId: string;
  hotelId: string;
  rooms: { name: string; id: string }[];
  flights: { key: string; number: string; route: string; id: string }[];
  bookings: { key: string; kind: 'hotel' | 'flight'; status: string; reference: string; id: string }[];
  itineraries: { key: string; title: string; visibility: string; id: string }[];
  /** Documents of the manifest before and after this run: equal numbers mean nothing new was created. */
  manifestBefore: number;
  manifestAfter: number;
  notes: string[];
}

interface AirportRef {
  iata: string;
  cityId: string;
  cityName: string;
  countryCode: string;
  name: string;
}

/** Thrown by --reset when a document of someone else depends on the seeded data. Nothing is deleted then. */
export class SeedResetBlockedError extends Error {}

type Doc = { _id: Types.ObjectId } & Record<string, any>;

const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const isoInstant = (offsetDays: number, hour: number) => {
  const d = new Date(Date.now() + offsetDays * DAY_MS);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

function model(connection: Connection, name: string): Model<any> {
  return connection.model(name) as Model<any>;
}

/**
 * Creates the demo data through the real services of the app (so holds, seats, room availability,
 * prices and payment states come from the production code) and records every document in the manifest.
 * Running it again creates nothing new. Stripe is replaced by a local stand-in: no network call is made.
 */
export async function seedDemoData(app: INestApplicationContext, options: { password: string }): Promise<DemoSeedSummary> {
  const connection = app.get<Connection>(getConnectionToken(), { strict: false });
  const manifest = new SeedManifest(connection);
  const manifestBefore = (await manifest.all()).length;
  installLocalStripe(app);

  const auth = app.get(AuthService, { strict: false });
  const airlinesService = app.get(AirlinesService, { strict: false });
  const flightsService = app.get(FlightsService, { strict: false });
  const cabinsService = app.get(CabinInventoryService, { strict: false });
  const hotelsService = app.get(HotelsService, { strict: false });
  const hotelBookings = app.get(HotelBookingsService, { strict: false });
  const flightBookings = app.get(FlightBookingsService, { strict: false });
  const payments = app.get(PaymentsService, { strict: false });
  const itineraries = app.get(ItinerariesService, { strict: false });
  const currency = app.get(PlatformCurrencyService, { strict: false }).code;

  const users = model(connection, 'User');
  const flights = model(connection, 'Flight');
  const hotelBookingModel = model(connection, 'HotelBooking');
  const flightBookingModel = model(connection, 'FlightBooking');
  const paymentModel = model(connection, 'Payment');
  const refundModel = model(connection, 'Refund');
  const notes: string[] = [];

  /** Finds the document of an earlier run by its manifest key, or creates and records it. */
  async function ensure(key: string, target: Model<any>, create: () => Promise<Doc | null>): Promise<Doc> {
    const entry = await manifest.find(key);
    if (entry) {
      const found = (await target.findById(entry.docId).lean().exec()) as Doc | null;
      if (found) return found;
      await manifest.forget(key); // deleted by someone: create it again
    }
    const created = await create();
    if (!created) throw new Error(`The seed could not create ${key}`);
    const plain = (typeof (created as any).toObject === 'function' ? (created as any).toObject() : created) as Doc;
    await manifest.track(key, target.collection.name, plain._id);
    return plain;
  }

  // ---------- Preconditions: reference data and name collisions ----------
  const route = await pickRoute(connection);
  await assertNoCollisions(connection, manifest);
  await manifest.ensureIndex();

  // ---------- Users ----------
  const hash = await bcrypt.hash(options.password, 12);
  const rawUser = (u: { name: string; email: string; role: UserRole }) =>
    users.create({
      name: u.name,
      email: u.email,
      password: hash,
      role: u.role,
      preferredCurrency: currency,
      termsAcceptedAt: new Date(),
      isActive: true,
      isSuspended: false,
      mustChangePassword: false,
      lastActivityAt: new Date(),
    });
  const customer = (key: 'sara' | 'omar') =>
    ensure(`user:${key}`, users, async () => {
      const u = SEED_USERS[key];
      await auth.register({ name: u.name, email: u.email, password: options.password, acceptTerms: true });
      const created = await users.findOneAndUpdate({ email: u.email }, { $set: { preferredCurrency: currency } }, { returnDocument: 'after' }).exec();
      return created;
    });
  const admin = await ensure('user:admin', users, () => rawUser({ ...SEED_USERS.admin, role: UserRole.ADMIN }));
  const sara = await customer('sara');
  const omar = await customer('omar');
  const airlineMod = await ensure('user:airlineModerator', users, () => rawUser({ ...SEED_USERS.airlineModerator, role: UserRole.MODERATOR }));
  const hotelMod = await ensure('user:hotelModerator', users, () => rawUser({ ...SEED_USERS.hotelModerator, role: UserRole.MODERATOR }));
  const id = (doc: Doc) => String(doc._id);

  // ---------- Airline, policies, flights, cabins ----------
  const airline = await ensure('airline', model(connection, 'Airline'), async () => {
    await airlinesService.create({ name: SEED_AIRLINE.name, code: SEED_AIRLINE.code }, id(admin));
    return model(connection, 'Airline').findOne({ code: SEED_AIRLINE.code }).exec();
  });
  await users.updateOne({ _id: airlineMod._id }, { $set: { airlineId: id(airline), hotelId: null } });

  await ensure('baggage-policy', model(connection, 'BaggagePolicy'), async () => {
    await airlinesService.updateBaggagePolicy(
      id(airline),
      { carryOnAllowanceKg: 7, checkedBaggageAllowanceKg: 23, pricePerExtraBag: 30, maxExtraBagsPerPassenger: 3, currency },
      id(airlineMod),
    );
    return model(connection, 'BaggagePolicy').findOne({ airlineId: airline._id }).exec();
  });
  await ensure('cancellation-policy', model(connection, 'CancellationPolicy'), async () => {
    await airlinesService.updateCancellationPolicy(
      id(airline),
      {
        tiers: [
          { daysBeforeDeparture: 7, refundPercentage: 100 },
          { daysBeforeDeparture: 2, refundPercentage: 50 },
          { daysBeforeDeparture: 0, refundPercentage: 0 },
        ],
        description: 'Demo policy: full refund 7+ days before departure, 50% from 2 days, nothing after.',
      },
      id(airlineMod),
    );
    return model(connection, 'CancellationPolicy').findOne({ airlineId: airline._id }).exec();
  });

  const flightPlan = [
    { key: 'outbound', number: SEED_FLIGHT_NUMBERS.outbound, from: route.from.iata, to: route.to.iata, depart: isoInstant(30, 6), arrive: isoInstant(30, 9) },
    { key: 'return', number: SEED_FLIGHT_NUMBERS.return, from: route.to.iata, to: route.from.iata, depart: isoInstant(37, 10), arrive: isoInstant(37, 13) },
    { key: 'oneWay', number: SEED_FLIGHT_NUMBERS.oneWay, from: route.from.iata, to: route.to.iata, depart: isoInstant(45, 6), arrive: isoInstant(45, 9) },
  ] as const;
  const flightDocs: Record<string, Doc> = {};
  for (const plan of flightPlan) {
    const flight = await ensure(`flight:${plan.key}`, flights, async () => {
      await flightsService.create(
        { flightNumber: plan.number, airlineId: id(airline), departureAirport: plan.from, arrivalAirport: plan.to, departureTime: plan.depart, arrivalTime: plan.arrive },
        id(airlineMod),
      );
      return flights.findOne({ airlineId: airline._id, flightNumber: plan.number }).exec();
    });
    flightDocs[plan.key] = flight;
    const cabins = [
      { cabinClass: 'Economy', totalSeats: 60, price: 150, freeBagsCount: 1, maxWeightPerBagKg: 23 },
      { cabinClass: 'Business', totalSeats: 12, price: 400, freeBagsCount: 2, maxWeightPerBagKg: 32 },
    ];
    for (const cabin of cabins) {
      await ensure(`cabin:${plan.key}:${cabin.cabinClass}`, model(connection, 'CabinInventory'), async () => {
        await cabinsService.create(id(flight), cabin as never, id(airlineMod));
        return model(connection, 'CabinInventory').findOne({ flightId: flight._id, cabinClass: cabin.cabinClass }).exec();
      });
    }
  }

  // ---------- Hotel and rooms ----------
  const hotel = await ensure('hotel', model(connection, 'Hotel'), async () =>
    hotelsService.create({
      name: SEED_HOTEL_NAME,
      address: '1 Demo Street',
      cityId: route.to.cityId,
      countryId: route.to.countryCode,
      description: 'Demo hotel created by npm run seed. Photos are placeholder links, not uploaded files.',
      photos: ['https://example.com/demo-seed/hotel-front.jpg', 'https://example.com/demo-seed/hotel-lobby.jpg', 'https://example.com/demo-seed/hotel-pool.jpg'],
      starClass: 4,
      amenities: ['wifi', 'pool', 'breakfast'],
      checkInTime: '15:00',
      checkOutTime: '11:00',
      cancellationTiers: [
        { daysBeforeCheckIn: 14, refundPercentage: 100 },
        { daysBeforeCheckIn: 3, refundPercentage: 50 },
        { daysBeforeCheckIn: 0, refundPercentage: 0 },
      ],
    } as never),
  );
  await users.updateOne({ _id: hotelMod._id }, { $set: { hotelId: id(hotel), airlineId: null } });

  const bookable = [{ startDate: isoDate(5), endDate: isoDate(150) }];
  const roomPlan = [
    { key: 'standard', name: 'Standard Double', type: 'standard', beds: 1, maxOccupancy: 2, pricePerNight: 100 },
    { key: 'deluxe', name: 'Deluxe Suite', type: 'suite', beds: 2, maxOccupancy: 4, pricePerNight: 250 },
  ];
  const roomDocs: Record<string, Doc> = {};
  for (const plan of roomPlan) {
    roomDocs[plan.key] = await ensure(`room:${plan.key}`, model(connection, 'Room'), async () => {
      await hotelsService.createRoom(
        id(hotel),
        { name: plan.name, type: plan.type, beds: plan.beds, maxOccupancy: plan.maxOccupancy, pricePerNight: plan.pricePerNight, currency, availabilityRanges: bookable } as never,
        id(hotelMod),
      );
      return model(connection, 'Room').findOne({ hotelId: hotel._id, name: plan.name }).exec();
    });
  }

  // ---------- Payments: the same states the signed webhook sets ----------
  async function pay(type: PaymentBookingType, booking: Doc, userId: string): Promise<void> {
    await payments.createPayment(userId, { bookingType: type, bookingId: id(booking) });
    const payment = (await paymentModel.findOne({ bookingType: type, bookingId: booking._id }).lean().exec()) as Doc | null;
    if (!payment) throw new Error('The seed could not create the payment of a booking');
    const body = Buffer.from(JSON.stringify(succeededEvent(payment as never)));
    await payments.handleStripeWebhook(body, 'seed-local');
  }
  const bookingModelOf = (type: PaymentBookingType) => (type === PaymentBookingType.HOTEL ? hotelBookingModel : flightBookingModel);
  async function statusOf(type: PaymentBookingType, booking: Doc): Promise<string> {
    return (await bookingModelOf(type).findById(booking._id).select('status').lean().exec())?.status;
  }
  /** Pending Payment -> Confirmed through the payment code. Does nothing when it is already past that. */
  async function confirm(type: PaymentBookingType, booking: Doc, userId: string): Promise<void> {
    if ((await statusOf(type, booking)) !== BOOKING_STATUS.PENDING_PAYMENT) return;
    await pay(type, booking, userId);
    const status = await statusOf(type, booking);
    if (status !== BOOKING_STATUS.CONFIRMED) throw new Error(`The payment did not confirm the booking (status ${status})`);
  }

  // ---------- Hotel bookings of Sara ----------
  const stay = (room: Doc, from: number, to: number, adults: number) => ({
    hotelId: id(hotel),
    checkInDate: isoDate(from),
    checkOutDate: isoDate(to),
    rooms: [{ roomId: id(room), adults, childrenAges: [] }],
    policiesAccepted: true,
  });
  const hotelPending = await ensure('booking:hotel-pending', hotelBookingModel, () => hotelBookings.create(id(sara), stay(roomDocs.standard, 20, 23, 2)));

  const hotelCompleted = await ensure('booking:hotel-completed', hotelBookingModel, () => hotelBookings.create(id(sara), stay(roomDocs.standard, 30, 33, 2)));
  await confirm(PaymentBookingType.HOTEL, hotelCompleted, id(sara));
  if ((await statusOf(PaymentBookingType.HOTEL, hotelCompleted)) === BOOKING_STATUS.CONFIRMED) {
    // The booking service refuses past dates, so the stay is moved into the past after the paid, confirmed booking exists.
    assertBookingTransition(BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED);
    await hotelBookingModel.updateOne(
      { _id: hotelCompleted._id, status: BOOKING_STATUS.CONFIRMED },
      { $set: { checkInDate: new Date(`${isoDate(-10)}T00:00:00.000Z`), checkOutDate: new Date(`${isoDate(-7)}T00:00:00.000Z`), status: BOOKING_STATUS.COMPLETED, completedAt: new Date() } },
    );
  }

  const hotelCancelled = await ensure('booking:hotel-cancelled', hotelBookingModel, () => hotelBookings.create(id(sara), stay(roomDocs.deluxe, 60, 62, 1)));
  await confirm(PaymentBookingType.HOTEL, hotelCancelled, id(sara));
  if ((await statusOf(PaymentBookingType.HOTEL, hotelCancelled)) === BOOKING_STATUS.CONFIRMED) {
    await payments.cancelBooking(id(sara), PaymentBookingType.HOTEL, id(hotelCancelled));
  }
  const cancelledPayment = (await paymentModel.findOne({ bookingType: PaymentBookingType.HOTEL, bookingId: hotelCancelled._id }).lean().exec()) as Doc | null;
  const refund = cancelledPayment ? ((await refundModel.findOne({ paymentId: cancelledPayment._id }).lean().exec()) as Doc | null) : null;
  if (refund?.status !== 'Refunded') throw new Error(`The cancelled booking has no Refunded refund (refund status: ${refund?.status ?? 'none'})`);

  // ---------- Flight booking of Sara: a paid round trip ----------
  const flightConfirmed = await ensure('booking:flight-confirmed', flightBookingModel, () =>
    flightBookings.create(id(sara), {
      outbound: { flightId: id(flightDocs.outbound), cabinClass: 'Economy' as never },
      return: { flightId: id(flightDocs.return), cabinClass: 'Economy' as never },
      passengers: [{ fullName: 'Sara Demo', dateOfBirth: '1992-04-12', nationalId: '29204121234567', nationality: route.from.countryCode }],
      policiesAccepted: true,
    }),
  );
  await confirm(PaymentBookingType.FLIGHT, flightConfirmed, id(sara));

  // ---------- Itineraries ----------
  const countries = [...new Set([route.from.countryCode, route.to.countryCode])];
  const start = isoDate(30);
  const publicItinerary = await ensure('itinerary:public', model(connection, 'Itinerary'), async () => {
    const created: any = await itineraries.create(id(sara), {
      title: `Demo: ${route.from.cityName} and ${route.to.cityName} in 3 days`,
      countryIds: countries,
      startDate: start,
      endDate: isoDate(32),
      visibility: 'public',
      displayCurrency: currency,
    } as never);
    const itineraryId = String(created.id ?? created._id);
    for (const [city, notesText] of [[route.from.cityId, 'Arrive and settle in'], [route.from.cityId, 'Full day of sightseeing'], [route.to.cityId, 'Fly out and explore']] as const) {
      await itineraries.addDay(id(sara), itineraryId, { cityId: city, notes: notesText });
    }
    const loaded: any = await itineraries.get(id(sara), itineraryId);
    const [d1, d2, d3] = loaded.days.map((d: any) => String(d.id ?? d._id));
    await itineraries.addActivity(id(sara), itineraryId, d1, { name: `Walking tour of ${route.from.cityName}`, description: 'Easy first-evening walk.', time: '18:00' } as never);
    await itineraries.addActivity(id(sara), itineraryId, d2, { name: 'Museum visit', description: 'Morning at the main museum.', time: '10:00' } as never);
    await itineraries.addActivity(id(sara), itineraryId, d2, { name: 'Local dinner', description: 'Dinner at a local restaurant.', time: '20:00' } as never);
    await itineraries.addActivity(id(sara), itineraryId, d3, { name: `City highlights of ${route.to.cityName}`, description: 'Evening tour after landing.', time: '17:00' } as never);
    await itineraries.addBudgetEntry(id(sara), itineraryId, d1, { description: 'Dinner', category: 'food', amount: 40, currency, type: 'planned' } as never);
    await itineraries.addBudgetEntry(id(sara), itineraryId, d1, { description: 'Hotel night', category: 'accommodation', amount: 100, currency, type: 'planned' } as never);
    await itineraries.addBudgetEntry(id(sara), itineraryId, d2, { description: 'Museum tickets', category: 'activities', amount: 60, currency, type: 'planned' } as never);
    await itineraries.addBudgetEntry(id(sara), itineraryId, d3, { description: 'Street food', category: 'food', amount: 35, currency, type: 'actual' } as never);
    await itineraries.addTransportCost(id(sara), itineraryId, { mode: 'flight', fromCityId: route.from.cityId, toCityId: route.to.cityId, amount: 150, currency, dayId: d3 } as never);
    return model(connection, 'Itinerary').findById(itineraryId).exec();
  });

  const privateItinerary = await ensure('itinerary:private', model(connection, 'Itinerary'), async () => {
    const created: any = await itineraries.create(id(omar), {
      title: `Demo (private): weekend in ${route.to.cityName}`,
      countryIds: [route.to.countryCode],
      startDate: isoDate(50),
      endDate: isoDate(51),
      visibility: 'private',
      displayCurrency: currency,
    } as never);
    const itineraryId = String(created.id ?? created._id);
    await itineraries.addDay(id(omar), itineraryId, { cityId: route.to.cityId, notes: 'Only visible to Omar' });
    await itineraries.addDay(id(omar), itineraryId, { cityId: route.to.cityId, notes: 'Beach and rest' });
    const loaded: any = await itineraries.get(id(omar), itineraryId);
    const firstDay = String(loaded.days[0].id ?? loaded.days[0]._id);
    await itineraries.addActivity(id(omar), itineraryId, firstDay, { name: 'Old town walk', description: 'Slow morning.', time: '09:30' } as never);
    await itineraries.addBudgetEntry(id(omar), itineraryId, firstDay, { description: 'Lunch', category: 'food', amount: 25, currency, type: 'planned' } as never);
    return model(connection, 'Itinerary').findById(itineraryId).exec();
  });

  // ---------- Summary ----------
  const statuses = async (type: PaymentBookingType, doc: Doc) => bookingModelOf(type).findById(doc._id).select('status reference').lean().exec() as Promise<Doc | null>;
  const bookingRows = [] as DemoSeedSummary['bookings'];
  for (const [key, kind, doc] of [
    ['hotel-pending', 'hotel', hotelPending],
    ['hotel-completed', 'hotel', hotelCompleted],
    ['hotel-cancelled', 'hotel', hotelCancelled],
    ['flight-confirmed', 'flight', flightConfirmed],
  ] as const) {
    const row = await statuses(kind === 'hotel' ? PaymentBookingType.HOTEL : PaymentBookingType.FLIGHT, doc);
    bookingRows.push({ key, kind, status: row?.status ?? 'unknown', reference: row?.reference ?? '', id: id(doc) });
  }
  if (bookingRows[0].status !== BOOKING_STATUS.PENDING_PAYMENT) {
    notes.push(`The pending hotel booking is now ${bookingRows[0].status} (its hold ended). Run npm run seed -- --reset --yes for a fresh hold.`);
  }
  if (flightDocs.outbound.departureTime < new Date()) {
    notes.push('The seeded flights are in the past. Run npm run seed -- --reset --yes to move them into the future.');
  }

  return {
    currency,
    route,
    users: (Object.keys(SEED_USERS) as SeedUserKey[]).map((key) => ({
      key,
      name: SEED_USERS[key].name,
      email: SEED_USERS[key].email,
      role: SEED_USERS[key].role,
      id: id({ admin, sara, omar, airlineModerator: airlineMod, hotelModerator: hotelMod }[key]),
    })),
    airlineId: id(airline),
    hotelId: id(hotel),
    rooms: roomPlan.map((plan) => ({ name: plan.name, id: id(roomDocs[plan.key]) })),
    flights: flightPlan.map((plan) => ({ key: plan.key, number: plan.number, route: `${plan.from}->${plan.to}`, id: id(flightDocs[plan.key]) })),
    bookings: bookingRows,
    itineraries: [
      { key: 'public (Sara)', title: String(publicItinerary.title), visibility: 'public', id: id(publicItinerary) },
      { key: 'private (Omar)', title: String(privateItinerary.title), visibility: 'private', id: id(privateItinerary) },
    ],
    manifestBefore,
    manifestAfter: (await manifest.all()).length,
    notes,
  };
}

/** CAI and DXB when both exist; otherwise the first two airports that are in different cities. */
async function pickRoute(connection: Connection): Promise<{ from: AirportRef; to: AirportRef }> {
  const airports = model(connection, 'Airport');
  const cities = model(connection, 'City');
  const ref = async (airport: Doc): Promise<AirportRef> => {
    const city = (await cities.findOne({ cityId: airport.cityId }).lean().exec()) as Doc | null;
    return { iata: airport.iataCode, cityId: airport.cityId, cityName: city?.name ?? airport.cityId, countryCode: airport.countryCode, name: airport.name };
  };
  const preferred = (await airports.find({ iataCode: { $in: ['CAI', 'DXB'] } }).lean().exec()) as unknown as Doc[];
  const cai = preferred.find((a) => a.iataCode === 'CAI');
  const dxb = preferred.find((a) => a.iataCode === 'DXB');
  if (cai && dxb) return { from: await ref(cai), to: await ref(dxb) };
  const any = (await airports.find({}).sort({ iataCode: 1 }).lean().exec()) as unknown as Doc[];
  const first = any[0];
  const second = any.find((a) => first && a.cityId !== first.cityId);
  if (!first || !second) {
    throw new Error('The reference data has no two airports in different cities. Run npm run seed:reference first.');
  }
  return { from: await ref(first), to: await ref(second) };
}

/** A real (not seeded) user or airline with the same e-mail or code stops the run before anything is written. */
async function assertNoCollisions(connection: Connection, manifest: SeedManifest): Promise<void> {
  const users = model(connection, 'User');
  const airlines = model(connection, 'Airline');
  for (const [key, u] of Object.entries(SEED_USERS)) {
    const existing = (await users.findOne({ email: u.email }).select('_id').lean().exec()) as Doc | null;
    const tracked = await manifest.find(`user:${key}`);
    if (existing && String(tracked?.docId) !== String(existing._id)) {
      throw new Error(`The user ${u.email} already exists and was not created by the seed. Nothing was written.`);
    }
  }
  const airline = (await airlines.findOne({ code: SEED_AIRLINE.code }).select('_id').lean().exec()) as Doc | null;
  const trackedAirline = await manifest.find('airline');
  if (airline && String(trackedAirline?.docId) !== String(airline._id)) {
    throw new Error(`An airline with code ${SEED_AIRLINE.code} already exists and was not created by the seed. Nothing was written.`);
  }
}

export interface DemoResetSummary {
  /** Documents deleted, by collection. */
  deleted: Record<string, number>;
}

/**
 * Deletes the documents of the manifest, and what only exists because of them: the payments, refunds, reviews,
 * itineraries and notifications of the seeded users, and the rooms, cabins and policies of the seeded hotel,
 * flights and airline. If a document of someone else depends on the seed (a booking or review of a real user
 * on the seeded hotel or flights) nothing is deleted at all.
 */
export async function resetDemoData(app: INestApplicationContext): Promise<DemoResetSummary> {
  const connection = app.get<Connection>(getConnectionToken(), { strict: false });
  const manifest = new SeedManifest(connection);
  const entries = await manifest.all();
  if (!entries.length) return { deleted: {} };

  const col = (name: string) => connection.collection(name);
  const collectionOf = (modelName: string) => model(connection, modelName).collection.name;
  const idsIn = (modelName: string) => entries.filter((e) => e.collection === collectionOf(modelName)).map((e) => e.docId);
  const userIds = idsIn('User');
  const hotelIds = idsIn('Hotel');
  const flightIds = idsIn('Flight');
  const airlineIds = idsIn('Airline');

  // Someone else's documents on the seeded data: stop before deleting anything.
  const blockers: string[] = [];
  const foreignHotelBookings = await col(collectionOf('HotelBooking')).countDocuments({ hotelId: { $in: hotelIds }, userId: { $nin: userIds } });
  if (foreignHotelBookings) blockers.push(`${foreignHotelBookings} hotel booking(s) of other users`);
  const foreignFlightBookings = await col(collectionOf('FlightBooking')).countDocuments({
    $or: [{ flightId: { $in: flightIds } }, { 'returnSegment.flightId': { $in: flightIds } }],
    userId: { $nin: userIds },
  });
  if (foreignFlightBookings) blockers.push(`${foreignFlightBookings} flight booking(s) of other users`);
  const foreignReviews = await col(collectionOf('Review')).countDocuments({ hotelId: { $in: hotelIds }, userId: { $nin: userIds } });
  if (foreignReviews) blockers.push(`${foreignReviews} review(s) of other users`);
  if (blockers.length) {
    throw new SeedResetBlockedError(`--reset stopped, nothing was deleted: ${blockers.join(', ')} depend on the seeded hotel or flights.`);
  }

  const deleted: Record<string, number> = {};
  const remove = async (collection: string, filter: Record<string, unknown>) => {
    const result = await col(collection).deleteMany(filter);
    deleted[collection] = (deleted[collection] ?? 0) + result.deletedCount;
  };

  const bookingFilters = {
    hotel: { $or: [{ userId: { $in: userIds } }, { hotelId: { $in: hotelIds } }] },
    flight: { $or: [{ userId: { $in: userIds } }, { flightId: { $in: flightIds } }, { 'returnSegment.flightId': { $in: flightIds } }] },
  };
  const hotelBookingIds = (await col(collectionOf('HotelBooking')).find(bookingFilters.hotel).project({ _id: 1 }).toArray()).map((d) => d._id);
  const flightBookingIds = (await col(collectionOf('FlightBooking')).find(bookingFilters.flight).project({ _id: 1 }).toArray()).map((d) => d._id);
  const paymentFilter = { $or: [{ userId: { $in: userIds } }, { bookingId: { $in: [...hotelBookingIds, ...flightBookingIds] } }] };
  const paymentIds = (await col(collectionOf('Payment')).find(paymentFilter).project({ _id: 1 }).toArray()).map((d) => d._id);

  await remove(collectionOf('StripeWebhookEvent'), { paymentId: { $in: paymentIds } });
  await remove(collectionOf('Refund'), { $or: [{ paymentId: { $in: paymentIds } }, { userId: { $in: userIds } }] });
  await remove(collectionOf('Payment'), { _id: { $in: paymentIds } });
  await remove(collectionOf('Review'), { $or: [{ userId: { $in: userIds } }, { hotelId: { $in: hotelIds } }] });
  await remove(collectionOf('HotelBooking'), { _id: { $in: hotelBookingIds } });
  await remove(collectionOf('FlightBooking'), { _id: { $in: flightBookingIds } });
  await remove(collectionOf('Itinerary'), { ownerId: { $in: userIds } });
  await remove(collectionOf('Notification'), { userId: { $in: userIds } });
  await remove(collectionOf('CabinInventory'), { flightId: { $in: flightIds } });
  await remove(collectionOf('BaggagePolicy'), { airlineId: { $in: airlineIds } });
  await remove(collectionOf('CancellationPolicy'), { airlineId: { $in: airlineIds } });
  await remove(collectionOf('Room'), { hotelId: { $in: hotelIds } });
  await remove(collectionOf('Flight'), { _id: { $in: flightIds } });
  await remove(collectionOf('Hotel'), { _id: { $in: hotelIds } });
  await remove(collectionOf('Airline'), { _id: { $in: airlineIds } });
  await remove(collectionOf('User'), { _id: { $in: userIds } });
  await manifest.clear();
  return { deleted };
}
