import { jest } from '@jest/globals';
import { Types } from 'mongoose';

import { CreateHotelBookingDto } from './dto/hotel-bookings.dto';
import { HotelBookingsService } from './hotel-bookings.service';
import { HotelBookingStatus } from './schemas/hotel-booking.schema';
import { BOOKING_HOLD_DURATION_MS } from '../../common/booking/booking-hold';

describe('HotelBookingsService', () => {
  const userId = new Types.ObjectId().toString();
  const hotelId = new Types.ObjectId().toString();
  const roomId = new Types.ObjectId().toString();
  const checkInDate = '2099-03-10';
  const checkOutDate = '2099-03-13';

  let service: HotelBookingsService;
  let hotelFindOne: ReturnType<typeof jest.fn>;
  let roomFind: ReturnType<typeof jest.fn>;
  let bookingFind: ReturnType<typeof jest.fn>;
  let bookingCreate: ReturnType<typeof jest.fn>;
  let roomUpdateMany: ReturnType<typeof jest.fn>;

  const dto = (): CreateHotelBookingDto => ({
    hotelId,
    checkInDate,
    checkOutDate,
    policiesAccepted: true,
    rooms: [{ roomId, adults: 2, childrenAges: [8] }],
  });

  beforeEach(() => {
    hotelFindOne = jest.fn(() => ({
      session: () => ({
      exec: async () => ({
        checkInTime: '15:00',
        checkOutTime: '11:00',
        cancellationTiers: [
          { daysBeforeCheckIn: 7, refundPercentage: 100 },
          { daysBeforeCheckIn: 0, refundPercentage: 0 },
        ],
      }),
      }),
    }));
    roomFind = jest.fn(() => ({
      session: () => ({
      exec: async () => [
        {
          _id: new Types.ObjectId(roomId),
          name: 'Deluxe',
          pricePerNight: 100,
          currency: 'EGP',
          maxOccupancy: 3,
          availabilityRanges: [
            {
              startDate: new Date('2099-03-01T00:00:00.000Z'),
              endDate: new Date('2099-04-01T00:00:00.000Z'),
            },
          ],
          blockedRanges: [],
        },
      ],
      }),
    }));
    bookingFind = jest.fn(() => ({
      select: () => ({
        session: () => ({ lean: () => ({ exec: async () => [] }) }),
      }),
    }));
    bookingCreate = jest.fn(async (value: Record<string, unknown>[]) => value);
    build();
  });

  const fakeConnection = () => ({
    startSession: async () => ({
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(async () => undefined),
      abortTransaction: jest.fn(async () => undefined),
      inTransaction: () => true,
      endSession: jest.fn(async () => undefined),
    }),
  });

  function build() {
    roomUpdateMany = jest.fn(() => ({ exec: async () => ({}) }));
    service = new HotelBookingsService(
      { findOne: hotelFindOne, find: bookingFind, create: bookingCreate } as never,
      { findOne: hotelFindOne } as never,
      { find: roomFind, updateMany: roomUpdateMany } as never,
      { cancelBooking: jest.fn() } as never,
      fakeConnection() as never,
    );
  }

  it('creates a priced pending hold with policy snapshots', async () => {
    const result = await service.create(userId, dto());

    expect(roomUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: [new Types.ObjectId(roomId)] } },
      { $inc: { holdSeq: 1 } },
      expect.anything(),
    );
    const [[created]] = bookingCreate.mock.calls as unknown as [[Record<string, unknown>[]]];
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(
      expect.objectContaining({
        totalPrice: 300,
        currency: 'EGP',
        status: HotelBookingStatus.PENDING_PAYMENT,
        checkInTime: '15:00',
        checkOutTime: '11:00',
        policiesAcceptedAt: expect.any(Date),
        cancellationTiers: [
          { daysBeforeCheckIn: 7, refundPercentage: 100 },
          { daysBeforeCheckIn: 0, refundPercentage: 0 },
        ],
      }),
    );
    expect(result).toMatchObject({ totalPrice: 300 });
  });

  it('holds the rooms for exactly 10 minutes (HTL-18)', async () => {
    const before = Date.now();
    await service.create(userId, dto());
    const [[created]] = bookingCreate.mock.calls as unknown as [[{ holdExpiresAt: Date }[]]];
    const ms = created[0].holdExpiresAt.getTime() - before;
    expect(ms).toBeGreaterThanOrEqual(BOOKING_HOLD_DURATION_MS);
    expect(ms).toBeLessThan(BOOKING_HOLD_DURATION_MS + 5_000);
    expect(BOOKING_HOLD_DURATION_MS).toBe(10 * 60 * 1000);
  });

  it('rejects check-out on or before check-in', async () => {
    await expect(
      service.create(userId, { ...dto(), checkOutDate: checkInDate }),
    ).rejects.toThrow('Check-in must be today or later and check-out must be after check-in');
    await expect(
      service.create(userId, { ...dto(), checkOutDate: '2099-03-09' }),
    ).rejects.toThrow('check-out must be after check-in');
    expect(bookingCreate).not.toHaveBeenCalled();
  });

  it('rejects a check-in date in the past', async () => {
    await expect(
      service.create(userId, { ...dto(), checkInDate: '2020-01-01', checkOutDate: '2020-01-03' }),
    ).rejects.toThrow('Check-in must be today or later');
    expect(bookingCreate).not.toHaveBeenCalled();
  });

  it('allows booking without accepting the policies (accept later, PAY-02)', async () => {
    await service.create(userId, { ...dto(), policiesAccepted: false });
    const [[created]] = bookingCreate.mock.calls as unknown as [[Record<string, unknown>[]]];
    expect(created[0]).toEqual(expect.objectContaining({ policiesAcceptedAt: null }));
  });

  it('rejects a room request that exceeds the room capacity', async () => {
    await expect(
      service.create(userId, {
        ...dto(),
        rooms: [{ roomId, adults: 3, childrenAges: [8] }],
      }),
    ).rejects.toThrow('Guest count exceeds room capacity for Deluxe');
    expect(bookingCreate).not.toHaveBeenCalled();
  });

  it('rejects rooms with an overlapping active reservation', async () => {
    bookingFind = jest.fn(() => ({
      select: () => ({
        session: () => ({
          lean: () => ({
            exec: async () => [{ rooms: [{ roomId: new Types.ObjectId(roomId) }] }],
          }),
        }),
      }),
    }));
    build();

    await expect(service.create(userId, dto())).rejects.toThrow(
      'One or more selected rooms are unavailable',
    );
    expect(bookingCreate).not.toHaveBeenCalled();
    expect(roomUpdateMany).not.toHaveBeenCalled();
  });
});
