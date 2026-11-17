export type ReferenceRow = Record<string, string>;
export function parseCsv(text: string): ReferenceRow[] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
    else if (c === '"') quoted = true; else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; } else field += c;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = (rows.shift() ?? []).map((x) => x.trim());
  if (!headers.length || headers.some((x) => !x) || new Set(headers).size !== headers.length) throw new Error('CSV must have unique, non-empty headers');
  return rows.filter((r) => r.some((x) => x.trim())).map((values) => Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? '').trim()])));
}
const value = (row: ReferenceRow, ...keys: string[]) => { const key = keys.find((k) => row[k] !== undefined); return key ? row[key].trim() : ''; };
function required(row: ReferenceRow, label: string, ...keys: string[]) { const v = value(row, ...keys); if (!v) throw new Error(`Missing ${label} in source row`); return v; }
function assertUnique(rows: ReferenceRow[], ...keys: string[]) { const ids = rows.map((r) => required(r, 'source identifier', ...keys)); if (new Set(ids).size !== ids.length) throw new Error('Duplicate source identifiers in dataset'); }
function validZone(zone: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } }
export function prepareReferenceData(countryRows: ReferenceRow[], cityRows: ReferenceRow[], airportRows: ReferenceRow[], attractionRows: ReferenceRow[]) {
  assertUnique(countryRows, 'id','ID','country_id'); assertUnique(cityRows, 'id','ID','city_id'); assertUnique(airportRows, 'id','ID','airport_id'); assertUnique(attractionRows, 'id','ID','attraction_id');
  const countryIds = new Set(countryRows.map((r) => required(r,'country id','id','ID','country_id'))), cityIds = new Set(cityRows.map((r) => required(r,'city id','id','ID','city_id')));
  const cityCountry = new Map(cityRows.map((r) => [required(r,'city id','id','ID','city_id'), required(r,'city country reference','country_id','Country ID','countryId')]));
  const countries = countryRows.map((r) => ({ sourceId: required(r,'country id','id','ID','country_id'), name: required(r,'country name','name','Name','country'), ...(value(r,'currency_code','Currency Code','currency') ? { currencyCode: value(r,'currency_code','Currency Code','currency').toUpperCase() } : {}) }));
  const cities = cityRows.map((r) => { const countryId = required(r,'city country reference','country_id','Country ID','countryId'); if (!countryIds.has(countryId)) throw new Error(`City references unknown country id ${countryId}`); return { sourceId: required(r,'city id','id','ID','city_id'), name: required(r,'city name','name','Name','city'), countryId }; });
  const airports = airportRows.map((r) => { const cityId = required(r,'airport city reference','city_id','City ID','cityId'), countryId = required(r,'airport country reference','country_id','Country ID','countryId'); if (cityId && !cityIds.has(cityId)) throw new Error(`Airport references unknown city id ${cityId}`); if (countryId && !countryIds.has(countryId)) throw new Error(`Airport references unknown country id ${countryId}`); if (cityId && countryId && cityCountry.get(cityId) !== countryId) throw new Error(`Airport city/country relationship is inconsistent for ${cityId}`); const timeZone = required(r,'IANA timezone','timeZone','timezone','time_zone','tz'); if (!validZone(timeZone)) throw new Error(`Invalid IANA timezone: ${timeZone}`); return { sourceId: required(r,'airport id','id','ID','airport_id'), name: required(r,'airport name','name','Name'), iataCode: required(r,'IATA code','iataCode','iata_code','IATA').toUpperCase(), timeZone, ...(cityId ? { cityId } : {}), ...(countryId ? { countryId } : {}), ...(value(r,'city','city_name') ? { city: value(r,'city','city_name') } : {}), ...(value(r,'country','country_name') ? { country: value(r,'country','country_name') } : {}) }; });
  const airportCodes = airports.map((airport) => airport.iataCode); if (new Set(airportCodes).size !== airportCodes.length) throw new Error('Duplicate airport IATA codes in dataset');
  const attractions = attractionRows.map((r) => { const cityId = required(r,'attraction city reference','city_id','City ID','cityId'); if (!cityIds.has(cityId)) throw new Error(`Attraction references unknown city id ${cityId}`); return { sourceId: required(r,'attraction id','id','ID','attraction_id'), name: required(r,'attraction name','name','Name'), cityId, ...(value(r,'description','Description') ? { description: value(r,'description','Description') } : {}) }; });
  return { countries, cities, airports, attractions };
}
export function upsertBySourceId<T extends { sourceId: string }>(records: T[]) { return records.map((doc) => ({ updateOne: { filter: { sourceId: doc.sourceId }, update: { $set: doc }, upsert: true } })); }

export function currenciesFromCountries(countries: Array<{ currencyCode?: string }>) { return [...new Set(countries.map((country) => country.currencyCode?.trim().toUpperCase()).filter((code): code is string => Boolean(code)))].sort(); }
