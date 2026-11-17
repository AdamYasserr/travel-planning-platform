/**
 * Pure parsing + validation for the official reference CSV datasets.
 * No I/O here so it can be unit tested without a database.
 */

export interface DatasetSpec {
  file: string;
  headers: readonly string[];
}

export const DATASETS = {
  countries: { file: 'Countries.csv', headers: ['code', 'name', 'currency'] },
  cities: { file: 'Cities.csv', headers: ['city_id', 'name', 'country_code'] },
  airports: { file: 'Airports.csv', headers: ['iata_code', 'name', 'city_id', 'country_code', 'time_zone'] },
  attractions: { file: 'Attractions.csv', headers: ['attraction_id', 'name', 'city_id'] },
} as const satisfies Record<string, DatasetSpec>;

export type DatasetKey = keyof typeof DATASETS;
export const IMPORT_ORDER: DatasetKey[] = ['countries', 'cities', 'airports', 'attractions'];

export class ReferenceImportError extends Error {}

export interface CsvRow {
  /** 1-based line number in the file (header is line 1). */
  line: number;
  values: Record<string, string>;
}
export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

export interface RowIssue {
  file: string;
  line: number;
  message: string;
}

export interface CountryDoc { code: string; name: string; currency: string }
export interface CityDoc { cityId: string; name: string; countryCode: string }
export interface AirportDoc { iataCode: string; name: string; cityId: string; countryCode: string; timeZone: string }
export interface AttractionDoc { attractionId: string; name: string; cityId: string }

export interface PreparedReferenceData {
  countries: CountryDoc[];
  cities: CityDoc[];
  airports: AirportDoc[];
  attractions: AttractionDoc[];
  issues: RowIssue[];
}

/** RFC 4180-style parser (quoted fields, escaped quotes, CRLF, BOM) that tracks source line numbers. */
export function parseCsv(text: string): ParsedCsv {
  const src = text.replace(/^﻿/, '');
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  const endRecord = () => {
    fields.push(field);
    records.push({ line: recordLine, fields });
    fields = [];
    field = '';
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === '\n') line++; field += c; }
    } else if (c === '"') quoted = true;
    else if (c === ',') { fields.push(field); field = ''; }
    else if (c === '\r') { /* ignore; handled with \n */ }
    else if (c === '\n') { endRecord(); line++; recordLine = line; }
    else field += c;
  }
  if (quoted) throw new ReferenceImportError('CSV contains an unterminated quoted field');
  if (field !== '' || fields.length) endRecord();

  const [head, ...body] = records;
  const headers = (head?.fields ?? []).map((h) => h.trim());
  const rows = body
    .filter((r) => r.fields.some((f) => f.trim() !== ''))
    .map((r) => ({ line: r.line, values: Object.fromEntries(headers.map((h, i) => [h, (r.fields[i] ?? '').trim()])) }));
  return { headers, rows };
}

/** Headers must contain every required column (case-sensitive). Extra columns are ignored. */
export function validateHeaders(spec: DatasetSpec, headers: string[]): void {
  if (!headers.length || headers.every((h) => h === '')) {
    throw new ReferenceImportError(`${spec.file}: file is empty or has no header row. Expected columns: ${spec.headers.join(', ')}`);
  }
  const missing = spec.headers.filter((h) => !headers.includes(h));
  if (missing.length) {
    const noun = missing.length === 1 ? 'column' : 'columns';
    throw new ReferenceImportError(`${spec.file}: missing required ${noun} "${missing.join('", "')}". Found headers: ${headers.join(', ')}`);
  }
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.trim() !== zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const CURRENCY = /^[A-Za-z]{3}$/;
const IATA = /^[A-Za-z]{3}$/;

/**
 * Validates every row, resolving references among the rows that passed validation in this run.
 * Invalid rows are reported (file + line) and skipped; a duplicate identifier keeps the first row.
 */
export function prepareReferenceData(input: Record<DatasetKey, ParsedCsv>): PreparedReferenceData {
  for (const key of IMPORT_ORDER) validateHeaders(DATASETS[key], input[key].headers);
  const issues: RowIssue[] = [];
  const reject = (key: DatasetKey, row: CsvRow, message: string) => issues.push({ file: DATASETS[key].file, line: row.line, message });

  const requireFields = (key: DatasetKey, row: CsvRow): boolean => {
    const empty = DATASETS[key].headers.filter((h) => !row.values[h]);
    if (empty.length) { reject(key, row, `empty value for ${empty.join(', ')}`); return false; }
    return true;
  };

  const countries = new Map<string, CountryDoc>();
  for (const row of input.countries.rows) {
    if (!requireFields('countries', row)) continue;
    const code = row.values.code.toUpperCase();
    if (!CURRENCY.test(row.values.currency)) { reject('countries', row, `currency "${row.values.currency}" is not a 3-letter code`); continue; }
    if (countries.has(code)) { reject('countries', row, `duplicate country code "${code}"`); continue; }
    countries.set(code, { code, name: row.values.name, currency: row.values.currency.toUpperCase() });
  }

  const cities = new Map<string, CityDoc>();
  for (const row of input.cities.rows) {
    if (!requireFields('cities', row)) continue;
    const cityId = row.values.city_id;
    const countryCode = row.values.country_code.toUpperCase();
    if (!countries.has(countryCode)) { reject('cities', row, `country_code "${row.values.country_code}" does not exist in Countries.csv`); continue; }
    if (cities.has(cityId)) { reject('cities', row, `duplicate city_id "${cityId}"`); continue; }
    cities.set(cityId, { cityId, name: row.values.name, countryCode });
  }

  const airports = new Map<string, AirportDoc>();
  for (const row of input.airports.rows) {
    if (!requireFields('airports', row)) continue;
    const { iata_code, name, city_id, time_zone } = row.values;
    const countryCode = row.values.country_code.toUpperCase();
    const city = cities.get(city_id);
    if (!IATA.test(iata_code)) { reject('airports', row, `iata_code "${iata_code}" is not a 3-letter code`); continue; }
    if (!city) { reject('airports', row, `city_id "${city_id}" does not exist in Cities.csv`); continue; }
    if (!countries.has(countryCode)) { reject('airports', row, `country_code "${row.values.country_code}" does not exist in Countries.csv`); continue; }
    if (city.countryCode !== countryCode) { reject('airports', row, `city "${city_id}" belongs to ${city.countryCode}, not ${countryCode}`); continue; }
    if (!isValidTimeZone(time_zone)) { reject('airports', row, `time_zone "${time_zone}" is not a valid IANA zone`); continue; }
    const iataCode = iata_code.toUpperCase();
    if (airports.has(iataCode)) { reject('airports', row, `duplicate iata_code "${iataCode}"`); continue; }
    airports.set(iataCode, { iataCode, name, cityId: city_id, countryCode, timeZone: time_zone });
  }

  const attractions = new Map<string, AttractionDoc>();
  for (const row of input.attractions.rows) {
    if (!requireFields('attractions', row)) continue;
    const { attraction_id, name, city_id } = row.values;
    if (!cities.has(city_id)) { reject('attractions', row, `city_id "${city_id}" does not exist in Cities.csv`); continue; }
    if (attractions.has(attraction_id)) { reject('attractions', row, `duplicate attraction_id "${attraction_id}"`); continue; }
    attractions.set(attraction_id, { attractionId: attraction_id, name, cityId: city_id });
  }

  return {
    countries: [...countries.values()],
    cities: [...cities.values()],
    airports: [...airports.values()],
    attractions: [...attractions.values()],
    issues,
  };
}
