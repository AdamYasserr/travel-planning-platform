import { addDaysToIso, cityGroups, dayDate, pickCityGroup } from './itinerary-days';

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

describe('choosing a city group for a search (ITN-25, ITN-26)', () => {
  const groups = cityGroups(
    [
      { _id: 'a', dayNumber: 1, cityId: 'cairo' },
      { _id: 'b', dayNumber: 2, cityId: 'dubai' },
      { _id: 'c', dayNumber: 3, cityId: 'cairo' },
    ],
    new Date('2026-12-01T00:00:00.000Z'),
  );

  it('defaults to the first group; a city means its first group; a group number picks that group', () => {
    expect(pickCityGroup(groups, {})).toMatchObject({ index: 1, group: { cityId: 'cairo' } });
    expect(pickCityGroup(groups, { city: 'dubai' })).toMatchObject({ index: 2 });
    expect(pickCityGroup(groups, { city: 'cairo' })).toMatchObject({ index: 1 });
    expect(pickCityGroup(groups, { group: 3 })).toMatchObject({ index: 3, group: { cityId: 'cairo', startDate: '2026-12-03' } });
    expect(pickCityGroup(groups, { group: 3, city: 'cairo' })).toMatchObject({ index: 3 });
  });

  it('reports the field that is wrong', () => {
    expect(pickCityGroup(groups, { group: 4 })).toMatchObject({ field: 'group' });
    expect(pickCityGroup(groups, { group: 0 })).toMatchObject({ field: 'group' });
    expect(pickCityGroup(groups, { city: 'paris' })).toMatchObject({ field: 'city' });
    expect(pickCityGroup(groups, { group: 2, city: 'cairo' })).toMatchObject({ field: 'city' });
    expect(pickCityGroup([], {})).toMatchObject({ field: 'itinerary' });
  });

  it('adds days to a date', () => {
    expect(addDaysToIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToIso('2026-03-01', -1)).toBe('2026-02-28');
  });
});
