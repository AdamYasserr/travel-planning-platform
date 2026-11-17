import { jest } from '@jest/globals';
import { Types } from 'mongoose';

import { CabinClass } from '../flights/schemas/cabin-inventory.schema';
import { CreateFlightBookingDto } from './dto/flight-bookings.dto';
import { FlightBookingsService } from './flight-bookings.service';
import { FlightBookingStatus } from './enums/flight-booking-status.enum';

describe('FlightBookingsService', () => {
  const userId = new Types.ObjectId().toString();
  const flightId = new Types.ObjectId();
  const inventoryId = new Types.ObjectId();

  let service: FlightBookingsService;
  let bookingFind: ReturnType<typeof jest.fn>;
  let bookingCreate: ReturnType<typeof jest.fn>;
  let inventoryReserve: ReturnType<typeof jest.fn>;
  let inventoryUpdate: ReturnType<typeof jest.fn>;

  const dto = (): CreateFlightBookingDto => ({
    flightId: flightId.toString(),
    cabinClass: CabinClass.ECONOMY,
    policiesAccepted: true,
    passengers: [
      { fullName: 'Taylor Passenger', dateOfBirth: '1990-01-15' },
      { fullName: 'Morgan Passenger', dateOfBirth: '1987-05-22' },
    ],
  });

  beforeEach(() => {
    bookingFind = jest.fn(() => ({
      select: () => ({ lean: () => ({ exec: async () => [] }) }),
    }));
    bookingCreate = jest.fn(async (value: Record<string, unknown>) => value);
    inventoryReserve = jest.fn(() => ({
      exec: async () => ({
        _id: inventoryId,
        price: 50,
        currency: 'EUR',
        availableSeats: 3,
      }),
    }));
    inventoryUpdate = jest.fn(() => ({ exec: async () => ({ modifiedCount: 1 }) }));

    service = new FlightBookingsService(
      { find: bookingFind, create: bookingCreate } as never,
      {
        findOne: () => ({ exec: async () => ({ _id: flightId, airlineId: new Types.ObjectId() }) }),
      } as never,
      {
        findOne: () => ({
          exec: async () => ({
            _id: inventoryId,
            price: 50,
            currency: 'EUR',
          }),
        }),
        findOneAndUpdate: inventoryReserve,
        updateOne: inventoryUpdate,
      } as never,
      { findOne: () => ({ lean: () => ({ exec: async () => ({ tiers: [] }) }) }) } as never,
      { expireFlightHoldsForInventory: async () => undefined } as never,
    );
  });

  it('holds the requested seats and snapshots the current fare', async () => {
    const result = await service.create(userId, dto());

    expect(inventoryReserve).toHaveBeenCalledWith(
      expect.objectContaining({ availableSeats: { $gte: 2 } }),
      { $inc: { availableSeats: -2 } },
      { new: true },
    );
    expect(bookingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        totalPrice: 100,
        pricePerSeat: 50,
        currency: 'EUR',
        status: FlightBookingStatus.PENDING_PAYMENT,
      }),
    );
    expect(result).toMatchObject({ totalPrice: 100 });
  });

  it('rejects unaccepted policies before reserving seats', async () => {
    await expect(
      service.create(userId, { ...dto(), policiesAccepted: false }),
    ).rejects.toThrow('You must accept the flight booking policies');
    expect(inventoryReserve).not.toHaveBeenCalled();
  });

  it('does not oversell when the atomic seat reservation fails', async () => {
    inventoryReserve = jest.fn(() => ({ exec: async () => null }));
    service = new FlightBookingsService(
      { find: bookingFind, create: bookingCreate } as never,
      {
        findOne: () => ({ exec: async () => ({ _id: flightId, airlineId: new Types.ObjectId() }) }),
      } as never,
      {
        findOne: () => ({
          exec: async () => ({ _id: inventoryId, price: 50, currency: 'EUR' }),
        }),
        findOneAndUpdate: inventoryReserve,
        updateOne: inventoryUpdate,
      } as never,
      { findOne: () => ({ lean: () => ({ exec: async () => ({ tiers: [] }) }) }) } as never,
      { expireFlightHoldsForInventory: async () => undefined } as never,
    );

    await expect(service.create(userId, dto())).rejects.toThrow(
      'Not enough seats are available',
    );
    expect(bookingCreate).not.toHaveBeenCalled();
  });
});
