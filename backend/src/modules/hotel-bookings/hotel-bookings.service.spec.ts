import { jest } from '@jest/globals';
import { Types } from 'mongoose';

import { CreateHotelBookingDto } from './dto/hotel-bookings.dto';
import { HotelBookingsService } from './hotel-bookings.service';
import { HotelBookingStatus } from './schemas/hotel-booking.schema';

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

  const dto = (): CreateHotelBookingDto => ({
    hotelId,
    checkInDate,
    checkOutDate,
    policiesAccepted: true,
    rooms: [{ roomId, adults: 2, childrenAges: [8] }],
  });

  beforeEach(() => {
    hotelFindOne = jest.fn(() => ({
      exec: async () => ({
        checkInTime: '15:00',
        checkOutTime: '11:00',
        cancellationTiers: [
          { daysBeforeCheckIn: 7, refundPercentage: 100 },
          { daysBeforeCheckIn: 0, refundPercentage: 0 },
        ],
      }),
    }));
    roomFind = jest.fn(() => ({
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
    }));
    bookingFind = jest.fn(() => ({
      select: () => ({
        lean: () => ({ exec: async () => [] }),
      }),
    }));
    bookingCreate = jest.fn(async (value: Record<string, unknown>) => value);

    service = new HotelBookingsService(
      { findOne: hotelFindOne, find: bookingFind, create: bookingCreate } as never,
      { findOne: hotelFindOne } as never,
      { find: roomFind } as never,
      { cancelBooking: jest.fn() } as never,
    );
  });

  it('creates a priced pending hold with policy snapshots', async () => {
    const result = await service.create(userId, dto());

    expect(bookingCreate).toHaveBeenCalledWith(
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

  it('requires explicit policy acceptance', async () => {
    await expect(
      service.create(userId, { ...dto(), policiesAccepted: false }),
    ).rejects.toThrow('You must accept the hotel booking policies');
    expect(hotelFindOne).not.toHaveBeenCalled();
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
        lean: () => ({
          exec: async () => [{ rooms: [{ roomId: new Types.ObjectId(roomId) }] }],
        }),
      }),
    }));
    service = new HotelBookingsService(
      { findOne: hotelFindOne, find: bookingFind, create: bookingCreate } as never,
      { findOne: hotelFindOne } as never,
      { find: roomFind } as never,
      { cancelBooking: jest.fn() } as never,
    );

    await expect(service.create(userId, dto())).rejects.toThrow(
      'One or more selected rooms are unavailable',
    );
    expect(bookingCreate).not.toHaveBeenCalled();
  });
});
