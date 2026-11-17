import { jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection, Types } from 'mongoose';

import { UserRole } from '../../src/common/enums/user-role.enum';
import { Hotel, HotelSchema } from '../../src/modules/hotels/schemas/hotel.schema';
import { Room, RoomSchema } from '../../src/modules/hotels/schemas/room.schema';
import { Review, ReviewSchema } from '../../src/modules/hotels/schemas/review.schema';
import { HotelsService } from '../../src/modules/hotels/hotels.service';
import { HotelBookingsService } from '../../src/modules/hotel-bookings/hotel-bookings.service';
import { HotelBooking, HotelBookingSchema, HotelBookingStatus } from '../../src/modules/hotel-bookings/schemas/hotel-booking.schema';
import { FlightBooking, FlightBookingSchema } from '../../src/modules/flight-bookings/schemas/flight-booking.schema';
import { CabinInventory, CabinInventorySchema } from '../../src/modules/flights/schemas/cabin-inventory.schema';
import { Payment, PaymentSchema, StripeWebhookEvent, StripeWebhookEventSchema } from '../../src/modules/payments/schemas/payment.schema';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { User, UserSchema } from '../../src/users/user.schema';

const CHECK_IN = '2099-03-10';
const CHECK_OUT = '2099-03-13';

describe('hotel hold concurrency (HTL-18) on a real replica set', () => {
  let replSet: MongoMemoryReplSet;
  let conn: Connection;
  let hotelModel: any, roomModel: any, bookingModel: any, userModel: any;
  let bookings: HotelBookingsService;
  let hotels: HotelsService;
  let payments: PaymentsService;
  let hotelId: Types.ObjectId;
  const moderatorId = new Types.ObjectId();
  const userId = new Types.ObjectId().toString();

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    conn = await mongoose.createConnection(replSet.getUri()).asPromise();
    hotelModel = conn.model(Hotel.name, HotelSchema);
    roomModel = conn.model(Room.name, RoomSchema);
    bookingModel = conn.model(HotelBooking.name, HotelBookingSchema);
    userModel = conn.model(User.name, UserSchema);
    const reviewModel = conn.model(Review.name, ReviewSchema);
    const flightBookingModel = conn.model(FlightBooking.name, FlightBookingSchema);
    const inventoryModel = conn.model(CabinInventory.name, CabinInventorySchema);
    const paymentModel = conn.model(Payment.name, PaymentSchema);
    const webhookModel = conn.model(StripeWebhookEvent.name, StripeWebhookEventSchema);
    for (const m of [hotelModel, roomModel, bookingModel, userModel, reviewModel, flightBookingModel, inventoryModel, paymentModel, webhookModel]) {
      await m.createCollection();
      await m.createIndexes();
    }
    const stripe = { expireCheckoutSession: jest.fn(async () => undefined), cancelPaymentIntent: jest.fn(async () => undefined) };
    payments = new PaymentsService(paymentModel, webhookModel, bookingModel, flightBookingModel, inventoryModel, conn as never, stripe as never);
    bookings = new HotelBookingsService(bookingModel, hotelModel, roomModel, payments as never, conn as never);
    const references = { assertCityInCountry: jest.fn(async () => undefined) };
    const currencies = { assertSupported: jest.fn(async (c: string) => c) };
    hotels = new HotelsService(hotelModel, userModel, roomModel, bookingModel, reviewModel, references as never, currencies as never, conn as never);
  });

  afterAll(async () => {
    await conn?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await Promise.all([hotelModel, roomModel, bookingModel, userModel].map((m) => m.deleteMany({})));
    const hotel = await hotelModel.create({
      name: 'Nile Hotel', address: '1 Corniche', cityId: 'cairo', countryId: 'EG', starClass: 4,
      checkInTime: '15:00', checkOutTime: '11:00', cancellationTiers: [{ daysBeforeCheckIn: 0, refundPercentage: 0 }],
    });
    hotelId = hotel._id;
    await userModel.collection.insertOne({
      _id: moderatorId, name: 'Mod', email: 'mod@example.com', password: 'x', role: UserRole.MODERATOR,
      hotelId: hotelId.toString(), isActive: true, termsAcceptedAt: new Date(),
    });
  });

  const makeRoom = (name: string, extra: Record<string, unknown> = {}) =>
    roomModel.create({
      hotelId, name, type: 'Double', beds: 1, maxOccupancy: 3, pricePerNight: 100, currency: 'EGP',
      availabilityRanges: [{ startDate: new Date('2099-03-01T00:00:00Z'), endDate: new Date('2099-04-01T00:00:00Z') }],
      ...extra,
    });

  const hold = (roomIds: Types.ObjectId[], user = userId, dates: [string, string] = [CHECK_IN, CHECK_OUT]) =>
    bookings.create(user, {
      hotelId: hotelId.toString(), checkInDate: dates[0], checkOutDate: dates[1], policiesAccepted: true,
      rooms: roomIds.map((id) => ({ roomId: id.toString(), adults: 2, childrenAges: [] })),
    } as never);

  const pending = () => bookingModel.find({ status: HotelBookingStatus.PENDING_PAYMENT }).lean();

  it('two simultaneous holds for the same room and dates: exactly one succeeds', async () => {
    const room = await makeRoom('Deluxe');
    const results = await Promise.allSettled([hold([room._id], new Types.ObjectId().toString()), hold([room._id], new Types.ObjectId().toString())]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(await pending()).toHaveLength(1);
  });

  it('survives repeated races and many contenders: never more than one hold per room', async () => {
    for (let round = 0; round < 8; round++) {
      const room = await makeRoom(`Room-${round}`);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => hold([room._id], new Types.ObjectId().toString())),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictException); // 409, never 500
      }
      expect(await bookingModel.countDocuments({ 'rooms.roomId': room._id })).toBe(1);
    }
  });

  it('overlapping (not identical) date ranges also conflict, adjacent ranges do not', async () => {
    const room = await makeRoom('Deluxe');
    await hold([room._id]);
    await expect(hold([room._id], userId, ['2099-03-12', '2099-03-15'])).rejects.toBeInstanceOf(ConflictException);
    await expect(hold([room._id], userId, ['2099-03-13', '2099-03-15'])).resolves.toBeDefined(); // check-out day == next check-in
  });

  it('control: a plain transaction WITHOUT the holdSeq write allows write skew (both commit)', async () => {
    const room = await makeRoom('Deluxe');
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const naive = async () => {
      const session = await conn.startSession();
      try {
        session.startTransaction();
        const overlapping = await bookingModel.find({ 'rooms.roomId': room._id, status: HotelBookingStatus.PENDING_PAYMENT }).session(session);
        expect(overlapping).toHaveLength(0); // both see "free"
        if (++arrived === 2) release();
        await barrier; // both have read before either writes
        await bookingModel.create([{
          userId: new Types.ObjectId(), hotelId, checkInDate: new Date(CHECK_IN), checkOutDate: new Date(CHECK_OUT),
          rooms: [{ roomId: room._id, roomName: 'Deluxe', pricePerNight: 100, currency: 'EGP', adults: 2, childrenAges: [] }],
          totalPrice: 300, currency: 'EGP', status: HotelBookingStatus.PENDING_PAYMENT, holdExpiresAt: new Date(Date.now() + 600_000),
          policiesAcceptedAt: new Date(), checkInTime: '15:00', checkOutTime: '11:00',
        }], { session });
        await session.commitTransaction();
      } finally {
        await session.endSession();
      }
    };
    await Promise.all([naive(), naive()]);
    expect(await pending()).toHaveLength(2); // double booking: the transaction alone is NOT enough
  });

  it('multi-room: if one of three rooms is unavailable, none are held', async () => {
    const [a, b, c] = await Promise.all([makeRoom('A'), makeRoom('B'), makeRoom('C')]);
    await hold([b._id], new Types.ObjectId().toString()); // B is taken
    const before = await roomModel.find({ _id: { $in: [a._id, c._id] } }).lean();

    await expect(hold([a._id, b._id, c._id])).rejects.toThrow('One or more selected rooms are unavailable');

    expect(await pending()).toHaveLength(1); // only B's original hold
    expect(await bookingModel.countDocuments({ 'rooms.roomId': { $in: [a._id, c._id] } })).toBe(0);
    const after = await roomModel.find({ _id: { $in: [a._id, c._id] } }).lean();
    expect(after.map((r: any) => r.holdSeq)).toEqual(before.map((r: any) => r.holdSeq)); // no side effects
    await expect(hold([a._id, c._id])).resolves.toBeDefined(); // A and C were never held
  });

  it('multi-room: a blocked room rejects the whole request and holds nothing', async () => {
    const a = await makeRoom('A');
    const blocked = await makeRoom('B', { blockedRanges: [{ startDate: new Date('2099-03-11T00:00:00Z'), endDate: new Date('2099-03-12T00:00:00Z') }] });
    const c = await makeRoom('C');
    await expect(hold([a._id, blocked._id, c._id])).rejects.toBeInstanceOf(ConflictException);
    expect(await bookingModel.countDocuments({})).toBe(0);
  });

  it('multi-room success: all rooms in one Pending Payment reservation with a 10 minute hold', async () => {
    const [a, b, c] = await Promise.all([makeRoom('A'), makeRoom('B'), makeRoom('C')]);
    const before = Date.now();
    const booking: any = await hold([a._id, b._id, c._id]);
    expect(await bookingModel.countDocuments({})).toBe(1);
    expect(booking.rooms).toHaveLength(3);
    expect(booking.status).toBe(HotelBookingStatus.PENDING_PAYMENT);
    const ms = booking.holdExpiresAt.getTime() - before;
    expect(ms).toBeGreaterThanOrEqual(600_000);
    expect(ms).toBeLessThan(605_000);
  });

  it('expiry releases the rooms: a lapsed hold stops blocking and the job marks it Expired', async () => {
    const room = await makeRoom('Deluxe');
    const first: any = await hold([room._id], new Types.ObjectId().toString());
    await expect(hold([room._id])).rejects.toBeInstanceOf(ConflictException); // still held

    await bookingModel.updateOne({ _id: first._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await expect(hold([room._id])).resolves.toBeDefined(); // released immediately, before the cron runs

    await payments.expirePendingBookings();
    const stored: any = await bookingModel.findById(first._id).lean();
    expect(stored.status).toBe(HotelBookingStatus.EXPIRED);
    expect(await pending()).toHaveLength(1); // only the new hold
  });

  it('blocking a range cannot race with a hold: exactly one of them wins', async () => {
    for (let round = 0; round < 8; round++) {
      const room = await makeRoom(`Race-${round}`);
      const [holdResult, blockResult] = await Promise.allSettled([
        hold([room._id]),
        hotels.blockRoomDates(hotelId.toString(), room._id.toString(), { blockedRanges: [{ startDate: CHECK_IN, endDate: CHECK_OUT }] } as never, moderatorId.toString()),
      ]);
      const wins = [holdResult, blockResult].filter((r) => r.status === 'fulfilled').length;
      expect(wins).toBe(1);
      for (const r of [holdResult, blockResult]) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictException);
      }
      const stored: any = await roomModel.findById(room._id).lean();
      const held = await bookingModel.countDocuments({ 'rooms.roomId': room._id });
      expect(held > 0 && stored.blockedRanges.length > 0).toBe(false); // never both
    }
  });

  it('deactivating a room cannot race with a hold either', async () => {
    for (let round = 0; round < 5; round++) {
      const room = await makeRoom(`Deact-${round}`);
      const [holdResult, deactivateResult] = await Promise.allSettled([
        hold([room._id]),
        hotels.deactivateRoom(hotelId.toString(), room._id.toString(), moderatorId.toString()),
      ]);
      const wins = [holdResult, deactivateResult].filter((r) => r.status === 'fulfilled').length;
      expect(wins).toBe(1);
      const stored: any = await roomModel.findById(room._id).lean();
      const held = await bookingModel.countDocuments({ 'rooms.roomId': room._id });
      expect(held > 0 && stored.isActive === false).toBe(false);
    }
  });
});
