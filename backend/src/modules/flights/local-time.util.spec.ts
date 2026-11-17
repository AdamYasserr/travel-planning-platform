import { isCalendarDate } from '../../common/validators/calendar-date.decorator';
import { localDateInZone, localDayRangeUtc, toLocalInstant } from './timezone.util';

describe('airport-local time helpers (GEN-06, FLT-11)', () => {
  it('shows the local wall clock, the offset and the UTC instant', () => {
    expect(toLocalInstant(new Date('2026-12-05T08:00:00Z'), 'Africa/Cairo')).toEqual({
      local: '2026-12-05T10:00:00', utcOffset: '+02:00', timeZone: 'Africa/Cairo', utc: '2026-12-05T08:00:00.000Z',
    });
    expect(toLocalInstant(new Date('2026-12-06T04:30:00Z'), 'America/New_York')).toMatchObject({ local: '2026-12-05T23:30:00', utcOffset: '-05:00' });
    expect(toLocalInstant(new Date('2026-07-01T12:00:00Z'), 'Asia/Kolkata')).toMatchObject({ local: '2026-07-01T17:30:00', utcOffset: '+05:30' });
  });

  it('knows which local date it is in a zone', () => {
    expect(localDateInZone(new Date('2026-12-05T23:30:00Z'), 'Asia/Dubai')).toBe('2026-12-06');
    expect(localDateInZone(new Date('2026-12-05T01:00:00Z'), 'America/New_York')).toBe('2026-12-04');
  });

  it('a normal local day is 24 hours', () => {
    const { start, end } = localDayRangeUtc('2026-12-05', 'Asia/Dubai');
    expect(start.toISOString()).toBe('2026-12-04T20:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-05T20:00:00.000Z');
  });

  it('the UK spring-forward day is 23 hours and the autumn day is 25 hours', () => {
    const spring = localDayRangeUtc('2027-03-28', 'Europe/London');
    expect(spring.start.toISOString()).toBe('2027-03-28T00:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2027-03-28T23:00:00.000Z');
    const autumn = localDayRangeUtc('2027-10-31', 'Europe/London');
    expect(autumn.start.toISOString()).toBe('2027-10-30T23:00:00.000Z');
    expect(autumn.end.toISOString()).toBe('2027-11-01T00:00:00.000Z');
  });

  it('copes with a zone whose local midnight does not exist (Cairo spring-forward)', () => {
    const { start, end } = localDayRangeUtc('2027-04-30', 'Africa/Cairo');
    expect(end.getTime() - start.getTime()).toBe(23 * 3600_000);
  });
});

describe('isCalendarDate', () => {
  it.each(['2026-12-05', '2028-02-29'])('accepts %s', (value) => expect(isCalendarDate(value)).toBe(true));
  it.each(['2026-02-30', '2027-02-29', '2026-1-5', '05/12/2026', '2026-13-01', '2026-12-05T00:00:00Z', '', 'x', 20261205, null])('rejects %s', (value) => expect(isCalendarDate(value)).toBe(false));
});
