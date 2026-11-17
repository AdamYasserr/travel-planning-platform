import { BadRequestException } from '@nestjs/common';

/** GEN-11: the only legal booking status transitions (hotel and flight bookings share the same lifecycle). */
export const BOOKING_STATUS = {
  PENDING_PAYMENT: 'Pending Payment',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
} as const;

const S = BOOKING_STATUS;

export const ALLOWED_BOOKING_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  [S.PENDING_PAYMENT]: [S.CONFIRMED, S.EXPIRED],
  [S.CONFIRMED]: [S.COMPLETED, S.CANCELLED],
  [S.COMPLETED]: [],
  [S.EXPIRED]: [],
  [S.CANCELLED]: [],
};

export function canTransitionBooking(from: string, to: string): boolean {
  return ALLOWED_BOOKING_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws 400 when `from -> to` is not an allowed transition. */
export function assertBookingTransition(from: string, to: string): void {
  if (!canTransitionBooking(from, to)) {
    throw new BadRequestException(`Invalid booking status transition: ${from} -> ${to}`);
  }
}
