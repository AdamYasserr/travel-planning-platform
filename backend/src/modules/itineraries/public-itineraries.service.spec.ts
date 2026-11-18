import { publicSearchFilter } from './public-itineraries.service';

describe('public itinerary search filter (ITN-20)', () => {
  it('always restricts to public itineraries, whatever the filters', () => {
    expect(publicSearchFilter({})).toEqual({ visibility: 'public' });
    expect(publicSearchFilter({ city: 'cairo', country: 'EG', from: '2026-12-01', to: '2026-12-31' })).toMatchObject({ visibility: 'public' });
  });

  it('city matches a day in that city; country matches the itinerary countries', () => {
    expect(publicSearchFilter({ city: 'cairo', country: 'EG' })).toEqual({ visibility: 'public', 'days.cityId': 'cairo', countryIds: 'EG' });
  });

  it('to: starts before the day after `to` (so it includes that whole day)', () => {
    expect(publicSearchFilter({ to: '2026-12-31' }).startDate).toEqual({ $lt: new Date('2027-01-01T00:00:00.000Z') });
  });

  it('from: the itinerary ends on or after it; without an end date it ends after as many days as it has', () => {
    const filter: any = publicSearchFilter({ from: '2026-12-01' });
    expect(filter.$expr.$gte[1]).toEqual(new Date('2026-12-01T00:00:00.000Z'));
    expect(JSON.stringify(filter.$expr.$gte[0])).toContain('$endDate');
    expect(JSON.stringify(filter.$expr.$gte[0])).toContain('$dateAdd');
  });
});
