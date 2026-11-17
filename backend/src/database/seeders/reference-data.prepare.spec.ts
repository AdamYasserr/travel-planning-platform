import { DATASETS, ParsedCsv, ReferenceImportError, parseCsv, prepareReferenceData, validateHeaders } from './reference-data.prepare';

const csv = (text: string): ParsedCsv => parseCsv(text.trim() + '\n');

const valid = () => ({
  countries: csv('code,name,currency\nEG,Egypt,EGP\nFR,France,eur'),
  cities: csv('city_id,name,country_code\ncairo,Cairo,EG\nparis,Paris,FR'),
  airports: csv('iata_code,name,city_id,country_code,time_zone\nCAI,Cairo International Airport,cairo,EG,Africa/Cairo\ncdg,Charles de Gaulle,paris,FR,Europe/Paris'),
  attractions: csv('attraction_id,name,city_id\natt-1,Giza Pyramids and Sphinx,cairo'),
});

describe('reference CSV parsing', () => {
  it('parses quoted commas, escaped quotes, CRLF and BOM, and tracks line numbers', () => {
    const parsed = parseCsv('﻿id,name\r\n1,"City, ""Old Town"""\r\n2,"multi\nline"\r\n3,x\r\n');
    expect(parsed.headers).toEqual(['id', 'name']);
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 3, 5]);
    expect(parsed.rows[0].values).toEqual({ id: '1', name: 'City, "Old Town"' });
  });
});

describe('header validation', () => {
  it('names the file and the missing column', () => {
    expect(() => validateHeaders(DATASETS.countries, ['code', 'name'])).toThrow(
      new ReferenceImportError('Countries.csv: missing required column "currency". Found headers: code, name'),
    );
  });

  it('is case sensitive and lists every missing column', () => {
    expect(() => validateHeaders(DATASETS.airports, ['IATA_CODE', 'name', 'city_id', 'country_code'])).toThrow(/Airports\.csv: missing required columns "iata_code", "time_zone"/);
  });

  it('rejects an empty file and ignores extra columns', () => {
    expect(() => validateHeaders(DATASETS.cities, [])).toThrow(/Cities\.csv: file is empty/);
    expect(() => validateHeaders(DATASETS.cities, ['city_id', 'name', 'country_code', 'extra'])).not.toThrow();
  });

  it('fails the whole import when any file has a bad header', () => {
    const input = { ...valid(), attractions: csv('id,name,city_id\nx,y,cairo') };
    expect(() => prepareReferenceData(input)).toThrow(/Attractions\.csv: missing required column "attraction_id"/);
  });
});

describe('row validation', () => {
  it('normalizes valid rows to dataset identifiers', () => {
    const out = prepareReferenceData(valid());
    expect(out.issues).toEqual([]);
    expect(out.countries).toEqual([{ code: 'EG', name: 'Egypt', currency: 'EGP' }, { code: 'FR', name: 'France', currency: 'EUR' }]);
    expect(out.airports[1]).toEqual({ iataCode: 'CDG', name: 'Charles de Gaulle', cityId: 'paris', countryCode: 'FR', timeZone: 'Europe/Paris' });
    expect(out.attractions).toEqual([{ attractionId: 'att-1', name: 'Giza Pyramids and Sphinx', cityId: 'cairo' }]);
  });

  it('reports file + line and skips invalid rows, keeping valid ones', () => {
    const input = {
      countries: csv('code,name,currency\nEG,Egypt,EGP\n,Nameless,USD\nXX,Badland,EURO\nEG,Dup,EGP'),
      cities: csv('city_id,name,country_code\ncairo,Cairo,EG\nghost,Ghost,ZZ'),
      airports: csv(
        [
          'iata_code,name,city_id,country_code,time_zone',
          'CAI,Cairo Intl,cairo,EG,Africa/Cairo',
          'AAA,No City,nowhere,EG,Africa/Cairo',
          'BBB,No Country,cairo,ZZ,Africa/Cairo',
          'CCC,Bad Zone,cairo,EG,Mars/Olympus',
          'DDD,Mismatch,cairo,FR,Europe/Paris',
          'CAI,Duplicate,cairo,EG,Africa/Cairo',
        ].join('\n'),
      ),
      attractions: csv('attraction_id,name,city_id\natt-1,Pyramids,cairo\natt-2,Orphan,ghost'),
    };
    const out = prepareReferenceData(input);
    expect(out.countries.map((c) => c.code)).toEqual(['EG']);
    expect(out.cities.map((c) => c.cityId)).toEqual(['cairo']);
    expect(out.airports.map((a) => a.iataCode)).toEqual(['CAI']);
    expect(out.attractions.map((a) => a.attractionId)).toEqual(['att-1']);
    const where = out.issues.map((i) => `${i.file}:${i.line}`);
    expect(where).toEqual([
      'Countries.csv:3', 'Countries.csv:4', 'Countries.csv:5',
      'Cities.csv:3',
      'Airports.csv:3', 'Airports.csv:4', 'Airports.csv:5', 'Airports.csv:6', 'Airports.csv:7',
      'Attractions.csv:3',
    ]);
    expect(out.issues.find((i) => i.file === 'Countries.csv' && i.line === 4)?.message).toMatch(/currency "EURO" is not a 3-letter code/);
    expect(out.issues.find((i) => i.file === 'Airports.csv' && i.line === 5)?.message).toMatch(/time_zone "Mars\/Olympus"/);
  });
});
