import { connect, disconnect, model } from 'mongoose';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CountrySchema } from '../../modules/reference-data/schemas/country.schema';
import { CitySchema } from '../../modules/reference-data/schemas/city.schema';
import { AirportSchema } from '../../modules/airports/schemas/airport.schema';
import { AttractionSchema } from '../../modules/reference-data/schemas/attraction.schema';
import { parseCsv, prepareReferenceData, upsertBySourceId } from './reference-data.prepare.js';
async function seed() {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') throw new Error('Reference data seeding is permitted only in development or test');
  const uri = process.env.MONGODB_URI, directory = process.env.REFERENCE_DATA_DIR;
  if (!uri || !directory) throw new Error('MONGODB_URI and REFERENCE_DATA_DIR are required');
  await connect(uri);
  try {
    const [countryRows, cityRows, airportRows, attractionRows] = await Promise.all(['Countries.csv','Cities.csv','Airports.csv','Attractions.csv'].map((name) => readFile(join(directory, name), 'utf8').then(parseCsv)));
    const { countries, cities, airports, attractions } = prepareReferenceData(countryRows, cityRows, airportRows, attractionRows);
    const collections = [[model('Country', CountrySchema), countries],[model('City', CitySchema), cities],[model('Airport', AirportSchema), airports],[model('Attraction', AttractionSchema), attractions]] as const;
    for (const [collection, records] of collections) if (records.length) await (collection as any).bulkWrite(upsertBySourceId(records as any[]), { ordered: true });
    console.log(`Imported ${countries.length} countries, ${cities.length} cities, ${airports.length} airports, ${attractions.length} attractions.`);
  } finally { await disconnect(); }
}
seed().catch((error: unknown) => { console.error('Reference data import failed:', error instanceof Error ? error.message : 'Unknown error'); process.exitCode = 1; });
