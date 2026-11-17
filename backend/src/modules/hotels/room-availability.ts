import { Types } from 'mongoose';

import { activeReservationClause } from '../hotel-bookings/room-reservation.util';

/**
 * THE rule for "is this room free for these dates" (HTL-04/05/06/11/15, HTL-18).
 * Hotel search, rooms/available, the moderator room statuses, hotel details, the availability-removal check AND
 * the booking hold all call this module, so search and booking cannot disagree.
 *
 * Dates are UTC-midnight dates. A stay is [checkIn, checkOut): check-out day is not a night. Availability and
 * blocked ranges use the same half-open convention (endDate exclusive).
 */

export interface DateRange {
  startDate: Date | string;
  endDate: Date | string;
}

export interface AvailabilityRoom {
  _id: Types.ObjectId | string;
  isActive?: boolean;
  availabilityRanges: DateRange[];
  blockedRanges?: DateRange[];
}

export interface ActiveBooking {
  rooms: Array<{ roomId: Types.ObjectId | string }>;
}

const time = (value: Date | string) => new Date(value).getTime();

/** Do [aStart, aEnd) and [bStart, bEnd) share at least one night? */
export function rangesOverlap(aStart: Date | string, aEnd: Date | string, bStart: Date | string, bEnd: Date | string): boolean {
  return time(aStart) < time(bEnd) && time(aEnd) > time(bStart);
}

/**
 * Is every night of the stay inside the bookable ranges? Ranges that TOUCH (one ends the day the next starts)
 * count as one continuous range, so a stay may span them (1-5 and 5-10 cover 3-8). A real gap breaks coverage.
 */
export function isStayCoveredByRanges(ranges: DateRange[], checkIn: Date | string, checkOut: Date | string): boolean {
  const sorted = [...ranges].sort((a, b) => time(a.startDate) - time(b.startDate));
  let coveredUntil = time(checkIn);
  const requiredUntil = time(checkOut);
  for (const range of sorted) {
    const start = time(range.startDate);
    const end = time(range.endDate);
    if (end <= coveredUntil) continue;
    if (start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, end);
    if (coveredUntil >= requiredUntil) return true;
  }
  return false;
}

/** Room-side rule: active, stay covered by its availability ranges, and no blocked range overlaps it. */
export function isRoomOpenForStay(room: AvailabilityRoom, checkIn: Date, checkOut: Date): boolean {
  if (room.isActive === false) return false;
  if ((room.blockedRanges ?? []).some((range) => rangesOverlap(range.startDate, range.endDate, checkIn, checkOut))) return false;
  return isStayCoveredByRanges(room.availabilityRanges, checkIn, checkOut);
}

/**
 * The active reservations that hold this room. `activeBookings` MUST come from `activeBookingsFilter` (the database
 * already applied "Confirmed or unexpired Pending Payment" and "overlaps the stay"), so only the room is matched here.
 */
export function bookingsForRoom<B extends ActiveBooking>(activeBookings: B[], roomId: Types.ObjectId | string): B[] {
  const id = String(roomId);
  return activeBookings.filter((booking) => booking.rooms.some((r) => String(r.roomId) === id));
}

/** A room is free when it is open for the stay and none of the (pre-filtered) active reservations holds it. */
export function isRoomFree(room: AvailabilityRoom, activeBookings: ActiveBooking[], checkIn: Date, checkOut: Date): boolean {
  return isRoomOpenForStay(room, checkIn, checkOut) && bookingsForRoom(activeBookings, room._id).length === 0;
}

export function findFreeRooms<R extends AvailabilityRoom>(rooms: R[], activeBookings: ActiveBooking[], checkIn: Date, checkOut: Date): R[] {
  return rooms.filter((room) => isRoomFree(room, activeBookings, checkIn, checkOut));
}

/**
 * Mongo filter that fetches the ACTIVE reservations (Confirmed, or Pending Payment with an unexpired hold) that
 * overlap the stay on any of these rooms. Pass its result to the functions above as `activeBookings`.
 */
export function activeBookingsFilter(roomIds: Array<Types.ObjectId | string>, checkIn: Date, checkOut: Date, now: Date = new Date()) {
  return {
    'rooms.roomId': { $in: roomIds },
    checkInDate: { $lt: checkOut },
    checkOutDate: { $gt: checkIn },
    $or: activeReservationClause(now),
  };
}

export const MS_PER_NIGHT = 86_400_000;
export const nightsBetween = (checkIn: Date, checkOut: Date) => Math.round((checkOut.getTime() - checkIn.getTime()) / MS_PER_NIGHT);
