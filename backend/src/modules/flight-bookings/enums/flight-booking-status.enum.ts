import { ConflictException } from '@nestjs/common';

// GEN-11: Flight booking lifecycle states
export enum FlightBookingStatus {
  PENDING_PAYMENT = 'Pending Payment',
  CONFIRMED = 'Confirmed',
  COMPLETED = 'Completed',
  EXPIRED = 'Expired',
  CANCELLED = 'Cancelled',
}

// GEN-11: The only allowed transitions. Everything else is rejected with 409.
//   Pending Payment -> Confirmed  (FLT-23, payment verified before the hold expires)
//   Pending Payment -> Expired    (FLT-22, hold time passed)
//   Confirmed       -> Completed  (outbound departure time passed)
//   Confirmed       -> Cancelled  (FLT-26 by the user, or FLT-06 by the airline)
export const FLIGHT_BOOKING_TRANSITIONS: Readonly<
  Record<FlightBookingStatus, readonly FlightBookingStatus[]>
> = {
  [FlightBookingStatus.PENDING_PAYMENT]: [
    FlightBookingStatus.CONFIRMED,
    FlightBookingStatus.EXPIRED,
  ],
  [FlightBookingStatus.CONFIRMED]: [
    FlightBookingStatus.COMPLETED,
    FlightBookingStatus.CANCELLED,
  ],
  [FlightBookingStatus.COMPLETED]: [],
  [FlightBookingStatus.EXPIRED]: [],
  [FlightBookingStatus.CANCELLED]: [],
};

export function canTransition(
  from: FlightBookingStatus,
  to: FlightBookingStatus,
): boolean {
  return FLIGHT_BOOKING_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(
  from: FlightBookingStatus,
  to: FlightBookingStatus,
  message?: string,
): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(
      message ?? `A ${from} booking cannot become ${to}`,
    );
  }
}

// FLT-12(b) / FLT-19: Passenger type, derived from date of birth
export enum PassengerType {
  ADULT = 'Adult', // 12+
  CHILD = 'Child', // 2-11
  INFANT = 'Infant', // under 2
}

export enum SegmentDirection {
  OUTBOUND = 'Outbound',
  RETURN = 'Return',
}

// PAY-03: Refund status (Pending / Refunded / Failed) is stored only on the
// Payment record (payments/enums/refund-status.enum.ts), not on the booking.

export enum FlightCancelledBy {
  USER = 'User',
  AIRLINE = 'Airline',
}
