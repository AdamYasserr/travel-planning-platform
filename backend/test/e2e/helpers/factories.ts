import * as bcrypt from 'bcryptjs';

import type { Agent, E2EContext } from './app';

export const PASSWORD = 'Passw0rd!ok';
export type Role = 'user' | 'moderator' | 'admin';

let counter = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}-${Math.random().toString(36).slice(2, 6)}`;

/** YYYY-MM-DD, UTC, `days` from today. */
export function day(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The id of a created document, whatever the response wraps it in. */
export function idOf(body: any): string {
  const id = body?._id ?? body?.id ?? body?.hotel?._id ?? body?.hotel?.id ?? body?.room?._id ?? body?.airline?._id ?? body?.flight?._id ?? body?.account?.id;
  if (!id) throw new Error(`no id in response: ${JSON.stringify(body)}`);
  return String(id);
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  /** Logged in (cookie jar holds access + refresh cookies). */
  agent: Agent;
}

/** POST /auth/login on a fresh agent; throws unless it succeeds. */
export async function login(ctx: E2EContext, email: string, password = PASSWORD): Promise<Agent> {
  const agent = ctx.agent();
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 201) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/**
 * Creates an account and logs it in. Accounts are written straight to the DB with a cheap bcrypt cost
 * (fast), except role 'user' with { viaApi: true }, which goes through POST /auth/register.
 * Moderators/admins can only exist through the DB or admin API; the admin API flow is covered in admin.e2e.ts.
 */
export async function createUser(
  ctx: E2EContext,
  role: Role = 'user',
  extra: { name?: string; email?: string; viaApi?: boolean; hotelId?: string; airlineId?: string; [k: string]: unknown } = {},
): Promise<TestUser> {
  const { viaApi, ...fields } = extra;
  const name = (fields.name as string) ?? `${role} ${unique('n')}`;
  const email = ((fields.email as string) ?? `${unique(role)}@e2e.test`).toLowerCase();
  let id: string;
  if (viaApi && role === 'user') {
    const res = await ctx.http().post('/api/auth/register').send({ name, email, password: PASSWORD, acceptTerms: true });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    const found = await ctx.conn.model('User').findOne({ email }).select('_id').lean();
    id = String(found!._id);
  } else {
    const doc = await ctx.conn.model('User').create({
      name, email, password: bcrypt.hashSync(PASSWORD, 4), role,
      termsAcceptedAt: new Date(), isActive: true, isSuspended: false, mustChangePassword: false, lastActivityAt: new Date(),
      ...Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'name' && k !== 'email')),
    });
    id = String(doc._id);
  }
  return { id, name, email, password: PASSWORD, role, agent: await login(ctx, email) };
}

export interface HotelFixture {
  hotelId: string;
  roomIds: string[];
  admin: TestUser;
  moderator: TestUser;
}

/** Hotel created by an admin, with `rooms` rooms and an availability range, managed by a hotel moderator. */
export async function createHotelWithRooms(
  ctx: E2EContext,
  opts: { admin?: TestUser; rooms?: number; availability?: { startDate: string; endDate: string }; pricePerNight?: number; currency?: string; cityId?: string; countryId?: string } = {},
): Promise<HotelFixture> {
  const admin = opts.admin ?? (await createUser(ctx, 'admin'));
  const hotelRes = await admin.agent.post('/api/hotels').send({
    name: unique('Hotel'), address: '12 Corniche Road', cityId: opts.cityId ?? 'cairo', countryId: opts.countryId ?? 'EG',
    starClass: 4, checkInTime: '15:00', checkOutTime: '11:00',
    cancellationTiers: [{ daysBeforeCheckIn: 7, refundPercentage: 100 }, { daysBeforeCheckIn: 0, refundPercentage: 0 }],
  });
  if (hotelRes.status !== 201) throw new Error(`hotel create failed: ${hotelRes.status} ${JSON.stringify(hotelRes.body)}`);
  const hotelId = idOf(hotelRes.body);
  const moderator = await createUser(ctx, 'moderator', { hotelId });

  const range = opts.availability ?? { startDate: day(1), endDate: day(120) };
  const roomIds: string[] = [];
  for (let i = 1; i <= (opts.rooms ?? 3); i++) {
    const roomRes = await moderator.agent.post(`/api/hotels/${hotelId}/rooms`).send({
      name: `Room ${100 + i}`, type: 'Standard double', beds: 2, maxOccupancy: 3,
      pricePerNight: opts.pricePerNight ?? 1500, currency: opts.currency ?? 'EGP',
    });
    if (roomRes.status !== 201) throw new Error(`room create failed: ${roomRes.status} ${JSON.stringify(roomRes.body)}`);
    const roomId = idOf(roomRes.body);
    const availRes = await moderator.agent.patch(`/api/hotels/${hotelId}/rooms/${roomId}/availability`).send({ availabilityRanges: [range] });
    if (availRes.status !== 200) throw new Error(`availability failed: ${availRes.status} ${JSON.stringify(availRes.body)}`);
    roomIds.push(roomId);
  }
  return { hotelId, roomIds, admin, moderator };
}

export interface FlightFixture {
  airlineId: string;
  flightId: string;
  seats: number;
  admin: TestUser;
  moderator: TestUser;
}

/** Airline + airline moderator + one future CAI->DXB flight with one Economy cabin. Needs seedReference() first. */
export async function createAirlineWithFlight(
  ctx: E2EContext,
  opts: { admin?: TestUser; seats?: number; departInDays?: number; price?: number } = {},
): Promise<FlightFixture> {
  const admin = opts.admin ?? (await createUser(ctx, 'admin'));
  const code = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const airlineRes = await admin.agent.post('/api/airlines').send({ name: unique('Air'), code });
  if (airlineRes.status !== 201) throw new Error(`airline create failed: ${airlineRes.status} ${JSON.stringify(airlineRes.body)}`);
  const airlineId = idOf(airlineRes.body);
  const moderator = await createUser(ctx, 'moderator', { airlineId });

  const depart = new Date(`${day(opts.departInDays ?? 30)}T08:00:00.000Z`);
  const arrive = new Date(depart.getTime() + 4 * 3600_000);
  const flightRes = await moderator.agent.post('/api/flights').send({
    flightNumber: `${code}${Math.floor(100 + Math.random() * 900)}`, airlineId,
    departureAirport: 'CAI', arrivalAirport: 'DXB', departureTime: depart.toISOString(), arrivalTime: arrive.toISOString(),
  });
  if (flightRes.status !== 201) throw new Error(`flight create failed: ${flightRes.status} ${JSON.stringify(flightRes.body)}`);
  const flightId = idOf(flightRes.body);
  const seats = opts.seats ?? 10;
  const cabinRes = await moderator.agent.post(`/api/flights/${flightId}/cabins`).send({
    cabinClass: 'Economy', totalSeats: seats, price: opts.price ?? 5000, currency: 'EGP', freeBagsCount: 1, maxWeightPerBagKg: 23,
  });
  if (cabinRes.status !== 201) throw new Error(`cabin create failed: ${cabinRes.status} ${JSON.stringify(cabinRes.body)}`);
  return { airlineId, flightId, seats, admin, moderator };
}

export interface AirlineFixture {
  airlineId: string;
  admin: TestUser;
  moderator: TestUser;
}

/** An airline and its moderator, with no flights. Pair with createFlight(). */
export async function createAirline(ctx: E2EContext, opts: { admin?: TestUser } = {}): Promise<AirlineFixture> {
  const admin = opts.admin ?? (await createUser(ctx, 'admin'));
  const code = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const res = await admin.agent.post('/api/airlines').send({ name: unique('Air'), code });
  if (res.status !== 201) throw new Error(`airline create failed: ${res.status} ${JSON.stringify(res.body)}`);
  const airlineId = idOf(res.body);
  return { airlineId, admin, moderator: await createUser(ctx, 'moderator', { airlineId }) };
}

export interface CabinSpec {
  cabinClass?: string;
  seats?: number;
  price?: number;
  freeBags?: number;
  maxKg?: number;
}

/**
 * A flight on an airline. `departure`/`arrival` are ISO timestamps with an offset, or airport-local date-times
 * without one (interpreted in that airport's time zone). Default route CAI -> DXB with one Economy cabin.
 */
export async function createFlight(
  ctx: E2EContext,
  airline: { airlineId: string; moderator: TestUser },
  o: { from?: string; to?: string; departure: string; arrival: string; cabins?: CabinSpec[] },
): Promise<string> {
  const res = await airline.moderator.agent.post('/api/flights').send({
    flightNumber: `${Math.floor(100 + Math.random() * 900)}${unique('f').slice(-4)}`, airlineId: airline.airlineId,
    departureAirport: o.from ?? 'CAI', arrivalAirport: o.to ?? 'DXB', departureTime: o.departure, arrivalTime: o.arrival,
  });
  if (res.status !== 201) throw new Error(`flight create failed: ${res.status} ${JSON.stringify(res.body)}`);
  const flightId = idOf(res.body);
  for (const cabin of o.cabins ?? [{}]) {
    const c = await airline.moderator.agent.post(`/api/flights/${flightId}/cabins`).send({
      cabinClass: cabin.cabinClass ?? 'Economy', totalSeats: cabin.seats ?? 10, price: cabin.price ?? 1000, currency: 'EGP',
      freeBagsCount: cabin.freeBags ?? 1, maxWeightPerBagKg: cabin.maxKg ?? 23,
    });
    if (c.status !== 201) throw new Error(`cabin create failed: ${c.status} ${JSON.stringify(c.body)}`);
  }
  return flightId;
}

/** `${day(n)}THH:mm:00.000Z`: a UTC instant on the day `n` days from today. */
export const at = (n: number, time: string) => `${day(n)}T${time}:00.000Z`;
