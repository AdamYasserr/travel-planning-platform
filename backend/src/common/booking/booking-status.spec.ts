import { BadRequestException } from '@nestjs/common';
import { ALLOWED_BOOKING_TRANSITIONS, BOOKING_STATUS as S, assertBookingTransition, canTransitionBooking } from './booking-status';
import { FlightBookingStatus } from '../../modules/flight-bookings/enums/flight-booking-status.enum';
import { HotelBookingStatus } from '../../modules/hotel-bookings/schemas/hotel-booking.schema';

describe('booking status transitions (GEN-11)', () => {
  const allowed: Array<[string, string]> = [
    [S.PENDING_PAYMENT, S.CONFIRMED],
    [S.CONFIRMED, S.COMPLETED],
    [S.PENDING_PAYMENT, S.EXPIRED],
    [S.CONFIRMED, S.CANCELLED],
  ];

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransitionBooking(from, to)).toBe(true);
    expect(() => assertBookingTransition(from, to)).not.toThrow();
  });

  it('rejects every other transition, including no-ops and unknown statuses', () => {
    const statuses = Object.values(S);
    for (const from of statuses) {
      for (const to of statuses) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect(canTransitionBooking(from, to)).toBe(expected);
        if (!expected) {
          expect(() => assertBookingTransition(from, to)).toThrow(BadRequestException);
        }
      }
    }
    expect(canTransitionBooking('Nonsense', S.CONFIRMED)).toBe(false);
  });

  it('explicitly forbids the tempting shortcuts', () => {
    expect(canTransitionBooking(S.PENDING_PAYMENT, S.CANCELLED)).toBe(false);
    expect(canTransitionBooking(S.PENDING_PAYMENT, S.COMPLETED)).toBe(false);
    expect(canTransitionBooking(S.EXPIRED, S.CONFIRMED)).toBe(false);
    expect(canTransitionBooking(S.CANCELLED, S.CONFIRMED)).toBe(false);
    expect(canTransitionBooking(S.COMPLETED, S.CANCELLED)).toBe(false);
    expect(ALLOWED_BOOKING_TRANSITIONS[S.COMPLETED]).toEqual([]);
  });

  it('uses the same status strings as the hotel and flight enums', () => {
    expect(Object.values(HotelBookingStatus).sort()).toEqual(Object.values(S).sort());
    expect(Object.values(FlightBookingStatus).sort()).toEqual(Object.values(S).sort());
  });
});
