import { jest } from '@jest/globals';
import { Types } from 'mongoose';

import { CabinClass } from '../flights/schemas/cabin-inventory.schema';
import { FlightStatus } from '../flights/schemas/flight.schema';
import { CreateFlightBookingDto } from './dto/flight-bookings.dto';
import { FlightBookingsService } from './flight-bookings.service';
import { FlightBookingStatus } from './enums/flight-booking-status.enum';

describe('FlightBookingsService', () => {
  const userId = new Types.ObjectId().toString();
  const flightId = new Types.ObjectId();
  const inventoryId = new Types.ObjectId();
  const departure = new Date(Date.now() + 30 * 86_400_000);

  let service: FlightBookingsService;
  let bookingCreate: ReturnType<typeof jest.fn>;
  let inventoryReserve: ReturnType<typeof jest.fn>;

  const baggage = { carryOnAllowanceKg: 7, checkedBaggageAllowanceKg: 23, pricePerExtraBag: 30, maxExtraBagsPerPassenger: 2, currency: 'EUR' };
  const cabin = { _id: inventoryId, flightId, cabinClass: CabinClass.ECONOMY, price: 50, currency: 'EUR', availableSeats: 3, freeBagsCount: 1, maxWeightPerBagKg: 23 };
  const lean = (value: unknown) => ({ lean: () => ({ exec: async () => value }) });

  const dto = (): CreateFlightBookingDto => ({
    flightId: flightId.toString(),
    cabinClass: CabinClass.ECONOMY,
    policiesAccepted: true,
    passengers: [
      { fullName: 'Taylor Passenger', dateOfBirth: '1990-01-15', passportNumber: 'A1234567', passportExpiry: '2045-01-01', nationality: 'EG' },
      { fullName: 'Morgan Passenger', dateOfBirth: '1987-05-22', nationalId: '29001011234567', nationality: 'EG' },
    ],
  });

  /** A session that runs the work once and commits (runBookingTransaction). */
  const connection = {
    startSession: async () => ({
      startTransaction: () => undefined,
      commitTransaction: async () => undefined,
      abortTransaction: async () => undefined,
      inTransaction: () => true,
      endSession: async () => undefined,
    }),
  };

  function build() {
    return new FlightBookingsService(
      { create: bookingCreate } as never,
      { findById: () => lean({ _id: flightId, airlineId: new Types.ObjectId(), status: FlightStatus.SCHEDULED, departureTime: departure, arrivalTime: new Date(departure.getTime() + 4 * 3_600_000) }) } as never,
      { findOne: () => lean(cabin), findOneAndUpdate: inventoryReserve } as never,
      { findOne: () => lean({ tiers: [] }) } as never,
      { findOne: () => lean(baggage) } as never,
      { expireFlightHoldsForInventory: async () => undefined } as never,
      { findById: () => ({ select: () => lean({ isActive: true }) }) } as never,
      { unknownCountryCodes: async () => [] } as never,
      connection as never,
    );
  }

  beforeEach(() => {
    bookingCreate = jest.fn(async (docs: Record<string, unknown>[]) => docs);
    inventoryReserve = jest.fn(() => lean(cabin));
    service = build();
  });

  const created = () => (bookingCreate.mock.calls[0] as unknown as [Record<string, any>[]])[0][0];

  it('holds the requested seats and snapshots the current fare', async () => {
    const result = await service.create(userId, dto());

    expect(inventoryReserve).toHaveBeenCalledWith(
      expect.objectContaining({ availableSeats: { $gte: 2 } }),
      { $inc: { availableSeats: -2 } },
      expect.objectContaining({ new: true }),
    );
    expect(created()).toMatchObject({
      totalPrice: 100,
      pricePerSeat: 50,
      currency: 'EUR',
      status: FlightBookingStatus.PENDING_PAYMENT,
    });
    expect(result).toMatchObject({ totalPrice: 100 });
  });

  it('holds seats for exactly 10 minutes (FLT-22)', async () => {
    const before = Date.now();
    await service.create(userId, dto());
    const ms = (created().holdExpiresAt as Date).getTime() - before;
    expect(ms).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(ms).toBeLessThan(10 * 60 * 1000 + 5_000);
  });

  it('accepted policies are timestamped at booking time and the baggage terms are snapshotted', async () => {
    await service.create(userId, dto());
    expect(created()).toMatchObject({
      policiesAcceptedAt: expect.any(Date),
      baggagePolicy: expect.objectContaining({ carryOnAllowanceKg: 7, pricePerExtraBag: 30 }),
    });
  });

  it('allows booking without accepting the policies (accept later, PAY-02)', async () => {
    await service.create(userId, { ...dto(), policiesAccepted: false });
    expect(created()).toMatchObject({ policiesAcceptedAt: null });
  });

  it('does not oversell when the atomic seat reservation fails', async () => {
    inventoryReserve = jest.fn(() => lean(null));
    service = build();

    await expect(service.create(userId, dto())).rejects.toThrow(
      'Not enough seats are available',
    );
    expect(bookingCreate).not.toHaveBeenCalled();
  });
});
