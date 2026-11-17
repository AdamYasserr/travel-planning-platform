import { jest } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import * as bcrypt from 'bcryptjs';
import mongoose, { Connection, Types } from 'mongoose';

import { AuthService, hashRefreshToken } from '../../src/auth/auth.service';
import { IDLE_TIMEOUT_MS, LOCK_TIME_MS, MAX_LOGIN_ATTEMPTS } from '../../src/auth/auth.constants';
import { UsersService } from '../../src/modules/users/users.service';
import { AdministrationService } from '../../src/modules/administration/administration.service';
import { User, UserSchema } from '../../src/users/user.schema';
import { Airline, AirlineSchema } from '../../src/modules/airlines/schemas/airline.schema';
import { Hotel, HotelSchema } from '../../src/modules/hotels/schemas/hotel.schema';
import { Flight, FlightSchema } from '../../src/modules/flights/schemas/flight.schema';
import { FlightBooking, FlightBookingSchema } from '../../src/modules/flight-bookings/schemas/flight-booking.schema';
import { HotelBooking, HotelBookingSchema } from '../../src/modules/hotel-bookings/schemas/hotel-booking.schema';
import { Post, PostSchema } from '../../src/modules/blog/schemas/post.schema';
import { Itinerary, ItinerarySchema } from '../../src/modules/itineraries/schemas/itinerary.schema';

const PASSWORD = 'Passw0rd!ok';

describe('auth, accounts and admin listings on a real MongoDB', () => {
  let replSet: MongoMemoryReplSet;
  let conn: Connection;
  let userModel: any, hotelBookingModel: any, flightBookingModel: any, postModel: any, itineraryModel: any;
  let hotelModel: any, airlineModel: any, flightModel: any;
  let auth: AuthService;
  let users: UsersService;
  let admin: AdministrationService;
  let jwt: JwtService;
  const passwordHash = bcrypt.hashSync(PASSWORD, 4);

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    conn = await mongoose.createConnection(replSet.getUri()).asPromise();
    userModel = conn.model(User.name, UserSchema);
    hotelBookingModel = conn.model(HotelBooking.name, HotelBookingSchema);
    flightBookingModel = conn.model(FlightBooking.name, FlightBookingSchema);
    postModel = conn.model(Post.name, PostSchema);
    itineraryModel = conn.model(Itinerary.name, ItinerarySchema);
    hotelModel = conn.model(Hotel.name, HotelSchema);
    airlineModel = conn.model(Airline.name, AirlineSchema);
    flightModel = conn.model(Flight.name, FlightSchema);
    for (const m of [userModel, hotelBookingModel, flightBookingModel, postModel, itineraryModel, hotelModel, airlineModel, flightModel]) {
      await m.createCollection();
      await m.createIndexes();
    }
    jwt = new JwtService({ secret: 'j'.repeat(40), signOptions: { expiresIn: '15m' } });
    const config = {
      getOrThrow: (key: string) => ({ 'auth.refreshTokenSecret': 'r'.repeat(40), 'auth.jwtSecret': 'j'.repeat(40) })[key],
      get: () => '7d',
    };
    const currencies = { assertSupported: jest.fn(async (c: string) => c.toUpperCase()) };
    users = new UsersService(userModel, currencies as never, hotelBookingModel, flightBookingModel, postModel, itineraryModel);
    auth = new AuthService(userModel, jwt, config as never, users);
    admin = new AdministrationService(userModel, airlineModel, hotelModel, flightBookingModel, hotelBookingModel, { record: jest.fn() } as never, { createForUsers: jest.fn() } as never, flightModel);
  });

  afterAll(async () => {
    await conn?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await Promise.all([userModel, hotelBookingModel, flightBookingModel, postModel, itineraryModel, hotelModel, airlineModel, flightModel].map((m) => m.deleteMany({})));
  });

  const seedUser = async (overrides: Record<string, unknown> = {}) =>
    userModel.create({ name: 'Amina', email: 'amina@example.com', password: passwordHash, ...overrides });
  const login = (password = PASSWORD, email = 'amina@example.com') => auth.login({ email, password });
  const status = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as HttpException).getStatus?.();

  describe('registration', () => {
    it('two simultaneous registrations of the same email: one 201, one 409 (unique index, never 500)', async () => {
      const dto = { name: 'Amina', email: 'dup@example.com', password: PASSWORD, acceptTerms: true } as never;
      const results = await Promise.allSettled([auth.register(dto), auth.register(dto)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect((rejected.reason as HttpException).getStatus()).toBe(409);
      expect(await userModel.countDocuments({ email: 'dup@example.com' })).toBe(1);
    });

    it('stores a salted bcrypt hash and never returns it', async () => {
      const { user } = await auth.register({ name: 'New', email: 'new@example.com', password: PASSWORD, acceptTerms: true } as never);
      expect(user).not.toHaveProperty('password');
      const stored = await userModel.findOne({ email: 'new@example.com' }).select('+password').lean();
      expect(stored.password).toMatch(/^\$2[aby]\$12\$/);
      const plain = await userModel.findOne({ email: 'new@example.com' }).lean();
      expect(plain.password).toBeUndefined(); // select: false
    });
  });

  describe('lockout (ACC-05)', () => {
    it('concurrent wrong passwords are counted atomically and lock the account exactly once', async () => {
      await seedUser();
      const statuses = await Promise.all(Array.from({ length: 12 }, () => status(login('Wrong-pass1'))));
      const doc = await userModel.findOne({ email: 'amina@example.com' }).lean();
      // Each counted attempt gets a unique number from the atomic $inc: attempts 1..4 answer 401, every later one
      // (and any request that arrives after the lock is set) answers 423. Timing only decides how many arrive late.
      expect(statuses.filter((s) => s === 401)).toHaveLength(MAX_LOGIN_ATTEMPTS - 1);
      expect(statuses.filter((s) => s === 423)).toHaveLength(12 - (MAX_LOGIN_ATTEMPTS - 1));
      expect(doc.failedLoginAttempts).toBeGreaterThanOrEqual(MAX_LOGIN_ATTEMPTS);
      expect(doc.failedLoginAttempts).toBeLessThanOrEqual(12);
      expect(doc.lockUntil).toBeInstanceOf(Date);
      expect(doc.lockUntil.getTime() - Date.now()).toBeLessThanOrEqual(LOCK_TIME_MS);
      expect(doc.lockUntil.getTime() - Date.now()).toBeGreaterThan(LOCK_TIME_MS - 60_000);
      expect(await status(login())).toBe(423); // correct password is refused while locked
    });

    it('full flow: 5 failures lock, expiry unlocks, success resets the counter', async () => {
      await seedUser();
      for (let i = 0; i < MAX_LOGIN_ATTEMPTS - 1; i++) expect(await status(login('Wrong-pass1'))).toBe(401);
      expect(await status(login('Wrong-pass1'))).toBe(423);
      await userModel.updateOne({ email: 'amina@example.com' }, { $set: { lockUntil: new Date(Date.now() - 1000) } }); // time passes
      await expect(login()).resolves.toBeDefined();
      const doc = await userModel.findOne({ email: 'amina@example.com' }).lean();
      expect(doc).toMatchObject({ failedLoginAttempts: 0, lockUntil: null });
    });
  });

  describe('sessions (ACC-06)', () => {
    it('refresh rotation, replay rejection, logout revocation and idle expiry', async () => {
      await seedUser();
      const first = await login();
      const second = await auth.refreshSession(first.refreshToken);
      await expect(auth.refreshSession(first.refreshToken)).rejects.toThrow('Invalid refresh token'); // replay of rotated token
      const stored = await userModel.findOne({ email: 'amina@example.com' }).select('+refreshTokenHash').lean();
      expect(stored.refreshTokenHash).toBe(hashRefreshToken(second.refreshToken));

      await auth.logout(second.refreshToken, second.accessToken);
      await expect(auth.refreshSession(second.refreshToken)).rejects.toThrow('Session has been revoked');

      const third = await login();
      await userModel.updateOne({ email: 'amina@example.com' }, { $set: { lastActivityAt: new Date(Date.now() - IDLE_TIMEOUT_MS - 5000) } });
      await expect(auth.refreshSession(third.refreshToken)).rejects.toThrow(/inactivity/);
      const after = await userModel.findOne({ email: 'amina@example.com' }).select('+refreshTokenHash').lean();
      expect(after.refreshTokenHash).toBeNull();
    });

    it('logout with an expired access cookie only still revokes the session', async () => {
      const user = await seedUser();
      await login();
      const expired = await jwt.signAsync({ sub: user._id.toString(), email: user.email, role: 'user' }, { expiresIn: -5 });
      await auth.logout(undefined, expired);
      const doc = await userModel.findById(user._id).select('+refreshTokenHash').lean();
      expect(doc.refreshTokenHash).toBeNull();
    });
  });

  describe('ACC-12 account deletion', () => {
    const futureHotelBooking = (userId: Types.ObjectId, status: string, checkOut: Date) =>
      hotelBookingModel.collection.insertOne({ userId, hotelId: new Types.ObjectId(), status, checkInDate: new Date(checkOut.getTime() - 86_400_000), checkOutDate: checkOut, rooms: [], totalPrice: 1, currency: 'EGP', createdAt: new Date() });
    const flightBooking = (userId: Types.ObjectId, status: string, departure: Date) =>
      flightBookingModel.collection.insertOne({ userId, flightId: new Types.ObjectId(), status, departureTime: departure, totalPrice: 1, currency: 'EUR', createdAt: new Date() });
    const day = 86_400_000;

    it('is blocked by an upcoming Confirmed hotel booking, then allowed once it is Cancelled', async () => {
      const user = await seedUser();
      const { insertedId } = await futureHotelBooking(user._id, 'Confirmed', new Date(Date.now() + 5 * day));
      expect(await status(auth.deactivateAccount(user._id.toString()))).toBe(409);
      expect((await userModel.findById(user._id).lean()).isActive).toBe(true);

      await hotelBookingModel.updateOne({ _id: insertedId }, { $set: { status: 'Cancelled' } });
      await expect(auth.deactivateAccount(user._id.toString())).resolves.toBeDefined();
      expect((await userModel.findById(user._id).lean()).isActive).toBe(false);
    });

    it('is blocked by an upcoming Confirmed flight; past, pending and completed bookings do not block', async () => {
      const user = await seedUser();
      await futureHotelBooking(user._id, 'Confirmed', new Date(Date.now() - 2 * day)); // stay finished
      await futureHotelBooking(user._id, 'Pending Payment', new Date(Date.now() + 5 * day));
      await flightBooking(user._id, 'Completed', new Date(Date.now() + 1 * day));
      const upcoming = await flightBooking(user._id, 'Confirmed', new Date(Date.now() + 3 * day));
      expect(await status(users.deactivateAccount(user._id.toString()))).toBe(409);
      await flightBookingModel.deleteOne({ _id: upcoming.insertedId });
      await expect(users.deactivateAccount(user._id.toString())).resolves.toBeDefined();
    });

    it('after deactivation: cannot log in, posts hidden, public itineraries private', async () => {
      const user = await seedUser();
      await postModel.collection.insertMany([
        { authorId: user._id, title: 'Public', body: 'b', status: 'published' },
        { authorId: user._id, title: 'Draft', body: 'b', status: 'draft' },
      ]);
      await itineraryModel.collection.insertOne({ ownerId: user._id, title: 'Trip', visibility: 'public' });
      await auth.deactivateAccount(user._id.toString());

      expect((await postModel.findOne({ title: 'Public' }).lean()).status).toBe('hidden');
      expect((await postModel.findOne({ title: 'Draft' }).lean()).status).toBe('draft');
      expect((await itineraryModel.findOne({ title: 'Trip' }).lean()).visibility).toBe('private');
      const error = await login().catch((e) => e);
      expect(error.message).toBe('Invalid email or password');
      expect(await status(login())).toBe(401);
    });
  });

  describe('ACC-14 admin account list', () => {
    it('combines search, role AND status filters with a page size of 10', async () => {
      for (let i = 0; i < 25; i++) await seedUser({ name: `User ${String(i).padStart(2, '0')}`, email: `u${i}@example.com` });
      await seedUser({ name: 'Mod One', email: 'mod1@example.com', role: 'moderator' });
      await seedUser({ name: 'Suspended Sam', email: 'sam@example.com', isSuspended: true });
      await seedUser({ name: 'Gone Gina', email: 'gina@example.com', isActive: false, deactivatedAt: new Date() });

      const page1 = await admin.listAccounts({ page: 1 } as never);
      expect(page1.items).toHaveLength(10);
      expect(page1.total).toBe(28);
      expect(page1.pages).toBe(3);
      const page3 = await admin.listAccounts({ page: 3 } as never);
      expect(page3.items).toHaveLength(8);
      expect(Object.keys(page1.items[0]).sort()).toEqual(['email', 'id', 'name', 'registeredAt', 'role', 'status']);

      const suspended = await admin.listAccounts({ page: 1, status: 'suspended' } as never);
      expect(suspended.items.map((i: any) => i.email)).toEqual(['sam@example.com']);
      const deactivated = await admin.listAccounts({ page: 1, status: 'deactivated' } as never);
      expect(deactivated.items.map((i: any) => i.email)).toEqual(['gina@example.com']);
      const activeMods = await admin.listAccounts({ page: 1, role: 'moderator', status: 'active' } as never);
      expect(activeMods.items.map((i: any) => i.email)).toEqual(['mod1@example.com']);
      const noMatch = await admin.listAccounts({ page: 1, role: 'moderator', status: 'suspended' } as never);
      expect(noMatch.total).toBe(0);
      const bySearch = await admin.listAccounts({ page: 1, search: 'SAM@' } as never);
      expect(bySearch.items.map((i: any) => i.name)).toEqual(['Suspended Sam']);
      const combined = await admin.listAccounts({ page: 1, search: 'example', role: 'user', status: 'active' } as never);
      expect(combined.total).toBe(25);
      expect(JSON.stringify(page1)).not.toMatch(/password|refreshTokenHash/);
    });
  });

  describe('ACC-17 admin booking list', () => {
    it('filters by type, status and date range on travel date (default) or booking date', async () => {
      const user = await seedUser();
      const hotel = await hotelModel.collection.insertOne({ name: 'Nile Hotel' });
      const airline = await airlineModel.collection.insertOne({ name: 'EgyptAir', code: 'MS' });
      const flight = await flightModel.collection.insertOne({ airlineId: airline.insertedId, flightNumber: 'MS777' });
      await hotelBookingModel.collection.insertMany([
        { userId: user._id, hotelId: hotel.insertedId, reference: 'H-DEC', status: 'Confirmed', checkInDate: new Date('2026-12-10'), checkOutDate: new Date('2026-12-12'), totalPrice: 300, currency: 'EGP', createdAt: new Date('2026-03-01') },
        { userId: user._id, hotelId: hotel.insertedId, reference: 'H-JAN', status: 'Cancelled', checkInDate: new Date('2027-01-10'), checkOutDate: new Date('2027-01-12'), totalPrice: 200, currency: 'EGP', createdAt: new Date('2026-12-05') },
      ]);
      await flightBookingModel.collection.insertMany([
        { userId: user._id, flightId: flight.insertedId, reference: 'F-DEC', status: 'Confirmed', departureTime: new Date('2026-12-31T22:00:00Z'), totalPrice: 100, currency: 'EUR', createdAt: new Date('2026-06-01') },
      ]);
      const refs = (r: { items: any[] }) => r.items.map((i) => i.reference).sort();

      expect(refs(await admin.listBookings({ page: 1 } as never))).toEqual(['F-DEC', 'H-DEC', 'H-JAN']);
      expect(refs(await admin.listBookings({ page: 1, type: 'hotel' } as never))).toEqual(['H-DEC', 'H-JAN']);
      expect(refs(await admin.listBookings({ page: 1, status: 'Confirmed' } as never))).toEqual(['F-DEC', 'H-DEC']);
      // travel date: December 2026, end day inclusive (flight departs 2026-12-31 22:00Z)
      expect(refs(await admin.listBookings({ page: 1, from: '2026-12-01', to: '2026-12-31' } as never))).toEqual(['F-DEC', 'H-DEC']);
      // booked date: December 2026 -> only the booking created on 2026-12-05
      expect(refs(await admin.listBookings({ page: 1, from: '2026-12-01', to: '2026-12-31', dateField: 'booked' } as never))).toEqual(['H-JAN']);

      const first = (await admin.listBookings({ page: 1, type: 'flight' } as never)).items[0];
      expect(first).toMatchObject({
        type: 'flight', reference: 'F-DEC', status: 'Confirmed',
        user: { name: 'Amina', email: 'amina@example.com' },
        provider: { name: 'EgyptAir', flightNumber: 'MS777' },
        amount: { total: 100, currency: 'EUR' },
        dates: { departure: new Date('2026-12-31T22:00:00Z') },
      });
    });
  });
});
