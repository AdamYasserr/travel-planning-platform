import { resolve } from 'node:path';

import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';

/**
 * The demo seed (`npm run seed`) on an in-memory replica set, never on Atlas: it is idempotent, it creates
 * a reviewable completed stay, and --reset removes only what the seed created.
 */
describe('demo seed', () => {
  let replSet: MongoMemoryReplSet;
  let app: any;
  let conn: Connection;
  let seed: typeof import('../../src/database/seeders/demo/demo-seed');
  const PASSWORD = 'SeedTest123';

  /** Documents per collection, so two runs can be compared. */
  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const c of await conn.db!.collections()) out[c.collectionName] = await c.countDocuments({});
    return out;
  }

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri('seedtest');
    if (!/^mongodb:\/\/127\.0\.0\.1/.test(uri)) throw new Error('the seed test must run on the in-memory MongoDB');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      MONGODB_URI: uri,
      JWT_SECRET: 'seed-jwt-secret-'.padEnd(40, 'x'),
      REFRESH_TOKEN_SECRET: 'seed-refresh-secret-'.padEnd(40, 'y'),
      COOKIE_SECURE: 'false',
      STRIPE_SECRET_KEY: 'sk_test_seed_not_used',
      STRIPE_WEBHOOK_SECRET: 'whsec_seed_not_used',
      PLATFORM_CURRENCY: 'USD',
      FXRATES_API_KEY: '',
    });
    await import('../../src/database/seeders/demo/seed-env');
    const { AppModule } = await import('../../src/app.module');
    const { createSeedApp } = await import('../../src/database/seeders/demo/seed-app');
    void AppModule;
    app = await createSeedApp();
    conn = app.get(getConnectionToken(), { strict: false });
    seed = await import('../../src/database/seeders/demo/demo-seed');

    // The reference data, imported with the project's own importer.
    const { readDatasets, importReferenceData } = await import('../../src/database/seeders/reference-import');
    const { KEY_FIELDS } = await import('../../src/database/seeders/reference-import');
    const names: Record<string, string> = { countries: 'Country', cities: 'City', airports: 'Airport', attractions: 'Attraction' };
    await importReferenceData(await readDatasets(resolve('data/reference')), {
      async upsert(dataset, keyField, docs) {
        const model = conn.model(names[dataset]);
        await model.createCollection();
        await model.bulkWrite(docs.map((doc) => ({ updateOne: { filter: { [keyField]: doc[keyField] }, update: { $set: doc }, upsert: true } })));
        return { inserted: docs.length, updated: 0, unchanged: 0 };
      },
    });
    void KEY_FIELDS;
    for (const model of Object.values(conn.models)) await model.createCollection().catch(() => undefined);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await replSet?.stop();
  });

  const run = () => seed.seedDemoData(app, { password: PASSWORD });

  it('a real user with a demo e-mail stops the seed before anything is written', async () => {
    const { AuthService } = await import('../../src/auth/auth.service');
    await app.get(AuthService, { strict: false }).register({ name: 'Real Sara', email: 'sara@demo-seed.test', password: 'RealPass123', acceptTerms: true });
    const before = await counts();
    await expect(run()).rejects.toThrow('was not created by the seed');
    expect(await counts()).toEqual(before);
    await conn.collection('users').deleteOne({ email: 'sara@demo-seed.test' });
  });

  it('creates the demo data, in the platform currency, and a second run creates nothing', async () => {
    const first = await run();
    expect(first.currency).toBe('USD');
    expect(first.users.map((u) => u.role).sort()).toEqual(['admin', 'moderator', 'moderator', 'user', 'user']);
    expect(first.bookings.map((b) => [b.key, b.status])).toEqual([
      ['hotel-pending', 'Pending Payment'],
      ['hotel-completed', 'Completed'],
      ['hotel-cancelled', 'Cancelled'],
      ['flight-confirmed', 'Confirmed'],
    ]);
    // Paid through the payment code; the cancelled booking has a Refunded refund.
    expect(await conn.collection('payments').countDocuments({ status: 'Succeeded' })).toBe(2);
    expect(await conn.collection('refunds').countDocuments({ status: 'Refunded' })).toBe(1);
    expect(await conn.collection('payments').countDocuments({ currency: { $ne: 'usd' } })).toBe(0);
    expect(await conn.collection('rooms').countDocuments({ currency: { $ne: 'USD' } })).toBe(0);
    expect(await conn.collection('cabininventories').countDocuments({ currency: { $ne: 'USD' } })).toBe(0);
    // The round trip holds seats on both flights; the cancelled hotel stay released its room.
    const roundTrip = await conn.collection('flightbookings').findOne({ tripType: 'round-trip' });
    expect(roundTrip?.status).toBe('Confirmed');
    // The hold lasts the seed's two hours.
    const pending = await conn.collection('hotelbookings').findOne({ status: 'Pending Payment' });
    expect(pending!.holdExpiresAt.getTime() - Date.now()).toBeGreaterThan(100 * 60_000);

    // Every demo user can log in with the printed password.
    const { AuthService } = await import('../../src/auth/auth.service');
    const auth = app.get(AuthService, { strict: false });
    for (const u of first.users) await expect(auth.login({ email: u.email, password: PASSWORD })).resolves.toBeDefined();

    const afterFirst = await counts();
    const second = await run();
    expect(second.manifestAfter).toBe(second.manifestBefore);
    expect(await counts()).toEqual(afterFirst);
    expect(second.users.map((u) => u.id)).toEqual(first.users.map((u) => u.id));
    expect(second.bookings.map((b) => b.id)).toEqual(first.bookings.map((b) => b.id));
    expect(await conn.collection('reviews').countDocuments({})).toBe(0);
  });

  it('the completed stay can be reviewed by its owner, and by nobody else', async () => {
    const { ReviewsService } = await import('../../src/modules/hotels/reviews.service');
    const reviews = app.get(ReviewsService, { strict: false });
    const summary = await run();
    const completed = summary.bookings.find((b) => b.key === 'hotel-completed')!;
    const sara = summary.users.find((u) => u.key === 'sara')!;
    const omar = summary.users.find((u) => u.key === 'omar')!;
    await expect(reviews.create(omar.id, completed.id, { rating: 5, comment: 'not mine' })).rejects.toMatchObject({ status: 404 });
    const pending = summary.bookings.find((b) => b.key === 'hotel-pending')!;
    await expect(reviews.create(sara.id, pending.id, { rating: 5 })).rejects.toMatchObject({ status: 409 });
    const review = await reviews.create(sara.id, completed.id, { rating: 5, comment: 'Great demo stay' });
    expect(review).toBeDefined();
    await conn.collection('reviews').deleteMany({}); // leave the seed as it was
    await conn.collection('hotels').updateOne({}, { $set: { averageRating: null, ratingCount: 0 } });
  });

  it('--reset removes only seeded documents; a real user, hotel and booking survive', async () => {
    const { AuthService } = await import('../../src/auth/auth.service');
    const { HotelBookingsService } = await import('../../src/modules/hotel-bookings/hotel-bookings.service');
    const auth = app.get(AuthService, { strict: false });
    await auth.register({ name: 'Real Person', email: 'real.person@example.com', password: 'RealPass123', acceptTerms: true });
    const real = (await conn.collection('users').findOne({ email: 'real.person@example.com' }))!;
    const realHotel = await conn.collection('hotels').insertOne({ name: 'Real Hotel', address: 'x', cityId: 'cairo', countryId: 'EG', starClass: 3, photos: [], amenities: [], checkInTime: '14:00', checkOutTime: '12:00', cancellationTiers: [], isActive: true, ratingCount: 0, averageRating: null });
    const realItinerary = await conn.collection('itineraries').insertOne({ ownerId: real._id, title: 'Real trip', countryIds: ['EG'], startDate: new Date(), days: [], transportCosts: [], visibility: 'private', displayCurrency: 'USD' });
    const seeded = await run();

    // A booking of a real user on the seeded hotel blocks the reset completely.
    const hotelBookings = app.get(HotelBookingsService, { strict: false });
    const deluxe = seeded.rooms.find((r) => r.name === 'Deluxe Suite')!;
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await hotelBookings.create(String(real._id), { hotelId: seeded.hotelId, checkInDate: day(100), checkOutDate: day(101), rooms: [{ roomId: deluxe.id, adults: 1, childrenAges: [] }], policiesAccepted: true });
    const before = await counts();
    await expect(seed.resetDemoData(app)).rejects.toBeInstanceOf(seed.SeedResetBlockedError);
    expect(await counts()).toEqual(before);
    await conn.collection('hotelbookings').deleteMany({ userId: real._id });

    const reset = await seed.resetDemoData(app);
    expect(Object.values(reset.deleted).reduce((a, b) => a + b, 0)).toBeGreaterThan(20);
    const after = await counts();
    for (const name of ['airlines', 'flights', 'cabininventories', 'rooms', 'hotelbookings', 'flightbookings', 'payments', 'refunds', 'seed_manifest', 'baggagepolicies', 'cancellationpolicies']) {
      expect({ name, count: after[name] }).toEqual({ name, count: 0 });
    }
    // Only the two real documents of users/hotels/itineraries are left.
    expect(after.users).toBe(1);
    expect(after.hotels).toBe(1);
    expect(after.itineraries).toBe(1);
    expect(await conn.collection('users').findOne({ _id: real._id })).not.toBeNull();
    expect(await conn.collection('hotels').findOne({ _id: realHotel.insertedId })).not.toBeNull();
    expect(await conn.collection('itineraries').findOne({ _id: realItinerary.insertedId })).not.toBeNull();

    // And the seed can be created again after a reset (new ids).
    const again = await run();
    expect(again.hotelId).not.toBe(seeded.hotelId);
    expect(again.bookings.map((b) => b.status)).toEqual(['Pending Payment', 'Completed', 'Cancelled', 'Confirmed']);
  });
});
