import { Types } from 'mongoose';

import { activeBookingsFilter, bookingsForRoom, findFreeRooms, isRoomFree, isRoomOpenForStay, isStayCoveredByRanges, nightsBetween, rangesOverlap } from './room-availability';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const range = (a: string, b: string) => ({ startDate: d(a), endDate: d(b) });
const room = (over: Partial<Parameters<typeof isRoomFree>[0]> = {}) => ({ _id: new Types.ObjectId(), isActive: true, availabilityRanges: [range('2030-01-01', '2030-02-01')], blockedRanges: [], ...over });
const booking = (r: { _id: unknown }, a: string, b: string) => ({ rooms: [{ roomId: r._id as Types.ObjectId }], checkInDate: d(a), checkOutDate: d(b) });

describe('room availability rule (shared by search, rooms/available, statuses and the booking hold)', () => {
  describe('availability ranges', () => {
    it('a stay inside one range is covered, the boundaries included', () => {
      const r = [range('2030-01-01', '2030-01-10')];
      expect(isStayCoveredByRanges(r, d('2030-01-03'), d('2030-01-06'))).toBe(true);
      expect(isStayCoveredByRanges(r, d('2030-01-01'), d('2030-01-10'))).toBe(true);
      expect(isStayCoveredByRanges(r, d('2029-12-31'), d('2030-01-03'))).toBe(false);
      expect(isStayCoveredByRanges(r, d('2030-01-08'), d('2030-01-11'))).toBe(false);
    });

    it('touching ranges count as one: 1-5 and 5-10 cover 3-8', () => {
      const r = [range('2030-01-05', '2030-01-10'), range('2030-01-01', '2030-01-05')];
      expect(isStayCoveredByRanges(r, d('2030-01-03'), d('2030-01-08'))).toBe(true);
      expect(isStayCoveredByRanges(r, d('2030-01-01'), d('2030-01-10'))).toBe(true);
    });

    it('a real gap between ranges breaks coverage, even by one night', () => {
      const r = [range('2030-01-01', '2030-01-05'), range('2030-01-06', '2030-01-10')];
      expect(isStayCoveredByRanges(r, d('2030-01-03'), d('2030-01-08'))).toBe(false);
      expect(isStayCoveredByRanges(r, d('2030-01-01'), d('2030-01-05'))).toBe(true);
      expect(isStayCoveredByRanges(r, d('2030-01-06'), d('2030-01-10'))).toBe(true);
    });

    it('no ranges means not bookable', () => {
      expect(isStayCoveredByRanges([], d('2030-01-03'), d('2030-01-04'))).toBe(false);
    });
  });

  describe('overlap', () => {
    it('stays that only share the check-out/check-in day do not overlap', () => {
      expect(rangesOverlap(d('2030-01-01'), d('2030-01-05'), d('2030-01-05'), d('2030-01-08'))).toBe(false);
      expect(rangesOverlap(d('2030-01-01'), d('2030-01-05'), d('2030-01-04'), d('2030-01-08'))).toBe(true);
    });
  });

  describe('a room is free only when open and unreserved', () => {
    it('is open when active, covered and not blocked', () => {
      expect(isRoomOpenForStay(room(), d('2030-01-10'), d('2030-01-12'))).toBe(true);
    });
    it('a deactivated room is never open', () => {
      expect(isRoomOpenForStay(room({ isActive: false }), d('2030-01-10'), d('2030-01-12'))).toBe(false);
    });
    it('a blocked range that overlaps closes the room; one that only touches does not', () => {
      const r = room({ blockedRanges: [range('2030-01-12', '2030-01-14')] });
      expect(isRoomOpenForStay(r, d('2030-01-10'), d('2030-01-13'))).toBe(false);
      expect(isRoomOpenForStay(r, d('2030-01-10'), d('2030-01-12'))).toBe(true);
      expect(isRoomOpenForStay(r, d('2030-01-14'), d('2030-01-16'))).toBe(true);
    });
    it('an active reservation (already filtered to overlap the stay) holding the room makes it not free', () => {
      const r = room();
      expect(isRoomFree(r, [booking(r, '2030-01-10', '2030-01-13')], d('2030-01-12'), d('2030-01-15'))).toBe(false);
      expect(isRoomFree(r, [], d('2030-01-13'), d('2030-01-15'))).toBe(true);
    });
    it('a reservation on another room does not matter', () => {
      const [a, b] = [room(), room()];
      expect(isRoomFree(a, [booking(b, '2030-01-10', '2030-01-13')], d('2030-01-10'), d('2030-01-13'))).toBe(true);
    });
    it('findFreeRooms keeps only the free ones', () => {
      const [free, booked, blocked, off] = [room(), room(), room({ blockedRanges: [range('2030-01-10', '2030-01-20')] }), room({ isActive: false })];
      const result = findFreeRooms([free, booked, blocked, off], [booking(booked, '2030-01-10', '2030-01-12')], d('2030-01-10'), d('2030-01-12'));
      expect(result).toEqual([free]);
    });
    it('bookingsForRoom returns only the bookings that hold that room', () => {
      const [a, b] = [room(), room()];
      const list = [booking(a, '2030-01-10', '2030-01-12'), booking(b, '2030-01-10', '2030-01-12')];
      expect(bookingsForRoom(list, a._id)).toEqual([list[0]]);
    });
  });

  it('the reservation filter asks for Confirmed and unexpired Pending Payment holds overlapping the stay', () => {
    const now = new Date('2030-01-01T10:00:00Z');
    const filter = activeBookingsFilter(['x'], d('2030-01-10'), d('2030-01-12'), now);
    expect(filter.checkInDate).toEqual({ $lt: d('2030-01-12') });
    expect(filter.checkOutDate).toEqual({ $gt: d('2030-01-10') });
    expect(JSON.stringify(filter.$or)).toContain('Confirmed');
    expect(JSON.stringify(filter.$or)).toContain('Pending Payment');
  });

  it('counts nights', () => {
    expect(nightsBetween(d('2030-01-10'), d('2030-01-13'))).toBe(3);
  });
});
