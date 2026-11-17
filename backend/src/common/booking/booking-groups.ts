import { BOOKING_STATUS as S } from './booking-status';

/** FLT-25 / HTL-20: the groups a user's booking list can be filtered by. */
export const BOOKING_GROUPS = ['upcoming', 'past', 'cancelled'] as const;
export type BookingGroup = (typeof BOOKING_GROUPS)[number];

const DAY_MS = 86_400_000;

/**
 * The MongoDB filter of one group. "Finished" follows the completion job (GEN-11): a flight at
 * departure, a hotel stay once its check-out day is over (so a stay in progress is still upcoming).
 *  - upcoming:  Confirmed and not finished, or a Pending Payment hold that is still live and not finished
 *  - past:      Completed, or Confirmed and finished (the job just has not run yet)
 *  - cancelled: Cancelled or Expired, or a Pending Payment hold that has lapsed (before the expiry job runs)
 */
export function bookingGroupFilter(kind: 'flight' | 'hotel', group: BookingGroup, now: Date = new Date()): Record<string, unknown> {
  const notFinished =
    kind === 'flight' ? { departureTime: { $gt: now } } : { checkOutDate: { $gt: new Date(now.getTime() - DAY_MS) } };
  const finished =
    kind === 'flight' ? { departureTime: { $lte: now } } : { checkOutDate: { $lte: new Date(now.getTime() - DAY_MS) } };
  switch (group) {
    case 'upcoming':
      return {
        $or: [
          { status: S.CONFIRMED, ...notFinished },
          { status: S.PENDING_PAYMENT, holdExpiresAt: { $gt: now }, ...notFinished },
        ],
      };
    case 'past':
      return { $or: [{ status: S.COMPLETED }, { status: S.CONFIRMED, ...finished }] };
    case 'cancelled':
      return {
        $or: [
          { status: { $in: [S.CANCELLED, S.EXPIRED] } },
          { status: S.PENDING_PAYMENT, $or: [{ holdExpiresAt: { $lte: now } }, { holdExpiresAt: null }, finished] },
        ],
      };
  }
}
