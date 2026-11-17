/**
 * HTL-18 / FLT-22: how long a Pending Payment reservation holds its rooms or seats.
 * Single source of truth for hotel and flight bookings; override with BOOKING_HOLD_MINUTES.
 */
export const DEFAULT_BOOKING_HOLD_MINUTES = 10;

export function resolveHoldMinutes(raw: string | undefined = process.env.BOOKING_HOLD_MINUTES): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BOOKING_HOLD_MINUTES;
}

export const BOOKING_HOLD_MINUTES = resolveHoldMinutes();
export const BOOKING_HOLD_DURATION_MS = BOOKING_HOLD_MINUTES * 60 * 1000;
