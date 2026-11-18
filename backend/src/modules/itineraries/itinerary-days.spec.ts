import { cityGroups, dayDate } from './itinerary-days';

describe('derived day dates and city groups (ITN-05, ITN-09)', () => {
  const start = new Date('2026-12-30T00:00:00.000Z');

  it('date = startDate + dayNumber - 1, across month and year ends', () => {
    expect(dayDate(start, 1)).toBe('2026-12-30');
    expect(dayDate(start, 3)).toBe('2027-01-01');
    expect(dayDate(new Date('2028-02-28T00:00:00.000Z'), 2)).toBe('2028-02-29');
  });

  it('uses the UTC calendar day of the start date, whatever its time', () => {
    expect(dayDate(new Date('2026-12-01T23:30:00.000Z'), 2)).toBe('2026-12-02');
  });

  it('groups consecutive days of the same city, and a city visited again is a new group', () => {
    const days = [
      { _id: 'a', dayNumber: 1, cityId: 'cairo' },
      { _id: 'b', dayNumber: 2, cityId: 'cairo' },
      { _id: 'c', dayNumber: 3, cityId: 'alexandria' },
      { _id: 'd', dayNumber: 4, cityId: 'cairo' },
    ];
    expect(cityGroups(days, start)).toEqual([
      { cityId: 'cairo', startDate: '2026-12-30', endDate: '2026-12-31', dayCount: 2, dayIds: ['a', 'b'] },
      { cityId: 'alexandria', startDate: '2027-01-01', endDate: '2027-01-01', dayCount: 1, dayIds: ['c'] },
      { cityId: 'cairo', startDate: '2027-01-02', endDate: '2027-01-02', dayCount: 1, dayIds: ['d'] },
    ]);
  });

  it('no days, no groups', () => {
    expect(cityGroups([], start)).toEqual([]);
  });
});
