import { bookingGroupFilter } from './booking-groups';

const now = new Date('2030-06-10T12:00:00.000Z');
const yesterdayNoon = new Date('2030-06-09T12:00:00.000Z');

describe('booking groups (FLT-25, HTL-20)', () => {
  it('upcoming: Confirmed not finished, or a live hold not finished', () => {
    expect(bookingGroupFilter('flight', 'upcoming', now)).toEqual({
      $or: [
        { status: 'Confirmed', departureTime: { $gt: now } },
        { status: 'Pending Payment', holdExpiresAt: { $gt: now }, departureTime: { $gt: now } },
      ],
    });
  });

  it('a hotel stay counts as finished only after its check-out day (in-progress stays are upcoming)', () => {
    expect(bookingGroupFilter('hotel', 'upcoming', now)).toEqual({
      $or: [
        { status: 'Confirmed', checkOutDate: { $gt: yesterdayNoon } },
        { status: 'Pending Payment', holdExpiresAt: { $gt: now }, checkOutDate: { $gt: yesterdayNoon } },
      ],
    });
  });

  it('past: Completed, or Confirmed and finished before the job ran', () => {
    expect(bookingGroupFilter('flight', 'past', now)).toEqual({ $or: [{ status: 'Completed' }, { status: 'Confirmed', departureTime: { $lte: now } }] });
  });

  it('cancelled: Cancelled, Expired, or a lapsed hold', () => {
    expect(bookingGroupFilter('hotel', 'cancelled', now)).toEqual({
      $or: [
        { status: { $in: ['Cancelled', 'Expired'] } },
        { status: 'Pending Payment', $or: [{ holdExpiresAt: { $lte: now } }, { holdExpiresAt: null }, { checkOutDate: { $lte: yesterdayNoon } }] },
      ],
    });
  });
});
