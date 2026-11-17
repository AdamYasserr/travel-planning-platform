import { currenciesFromCountries, parseCsv, prepareReferenceData, upsertBySourceId } from './reference-data.prepare.js';

describe('reference data preparation', () => {
  const source = () => prepareReferenceData(
    [{ id: 'C-001', name: 'Exampleland', currency_code: 'xyz' }],
    [{ id: 'CITY-9', name: 'Port Example', country_id: 'C-001' }],
    [{ id: 'APT-77', name: 'Example Airport', iata_code: 'exa', city_id: 'CITY-9', country_id: 'C-001', timezone: 'Africa/Cairo' }],
    [{ id: 'ATT-4', name: 'Museum', city_id: 'CITY-9' }],
  );
  it('parses quoted commas and escaped quotes from source CSV', () => {
    expect(parseCsv('id,name\r\n1,"City, \""Old Town\"""\r\n')).toEqual([{ id: '1', name: 'City, "Old Town"' }]);
  });
  it('preserves dataset IDs and relationships and validates airport zones', () => {
    const data = source();
    expect(data.countries[0]).toMatchObject({ sourceId: 'C-001', currencyCode: 'XYZ' });
    expect(data.cities[0]).toMatchObject({ sourceId: 'CITY-9', countryId: 'C-001' });
    expect(data.airports[0]).toMatchObject({ sourceId: 'APT-77', cityId: 'CITY-9', countryId: 'C-001', timeZone: 'Africa/Cairo' });
    expect(data.attractions[0]).toMatchObject({ sourceId: 'ATT-4', cityId: 'CITY-9' });
  });
  it('extracts distinct supported currencies from country records', () => {
    expect(currenciesFromCountries([{ currencyCode: 'usd' }, { currencyCode: 'EUR' }, { currencyCode: 'USD' }, {}])).toEqual(['EUR', 'USD']);
  });
  it('builds idempotent upserts keyed by original identifiers', () => {
    expect(upsertBySourceId([{ sourceId: 'original-42', name: 'x' }])).toEqual([{ updateOne: { filter: { sourceId: 'original-42' }, update: { $set: { sourceId: 'original-42', name: 'x' } }, upsert: true } }]);
  });
  it('rejects duplicate identifiers, missing references, inconsistent airport geography, and invalid zones', () => {
    expect(() => prepareReferenceData([{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }], [], [], [])).toThrow(/Duplicate/);
    expect(() => prepareReferenceData([{ id: 'x', name: 'A' }], [{ id: 'y', name: 'B', country_id: 'missing' }], [], [])).toThrow(/unknown country/);
    expect(() => prepareReferenceData([{ id: 'x', name: 'A' }], [{ id: 'y', name: 'B', country_id: 'x' }], [{ id: 'z', name: 'A', iata_code: 'AAA', city_id: 'y', country_id: 'other', timezone: 'Etc/UTC' }], [])).toThrow(/unknown country/);
    expect(() => prepareReferenceData([{ id: 'x', name: 'A' }], [{ id: 'y', name: 'B', country_id: 'x' }], [{ id: 'z', name: 'A', iata_code: 'AAA', city_id: 'y', country_id: 'x', timezone: 'Invalid/Zone' }], [])).toThrow(/Invalid IANA/);
    expect(() => prepareReferenceData([{ id: 'x', name: 'A' }], [{ id: 'y', name: 'B', country_id: 'x' }], [{ id: 'z', name: 'A', iata_code: 'AAA', city_id: 'y', country_id: 'x', timezone: 'Etc/UTC' }], [{ id: 'a', name: 'Museum', city_id: 'missing' }])).toThrow(/unknown city/);
  });
});
