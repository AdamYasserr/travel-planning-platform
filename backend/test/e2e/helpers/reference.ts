import { resolve } from 'node:path';
import type { Model } from 'mongoose';

import { AirportSchema } from '../../../src/modules/airports/schemas/airport.schema';
import { AttractionSchema } from '../../../src/modules/reference-data/schemas/attraction.schema';
import { CitySchema } from '../../../src/modules/reference-data/schemas/city.schema';
import { CountrySchema } from '../../../src/modules/reference-data/schemas/country.schema';
import { IMPORT_ORDER, type DatasetKey } from '../../../src/database/seeders/reference-data.prepare';
import { importReferenceData, readDatasets, type ReferenceStore } from '../../../src/database/seeders/reference-import';
import type { E2EContext } from './app';

const DATA_DIR = resolve(process.cwd(), 'data/reference');

/** Imports the official CSVs (backend/data/reference) with the real importer. Safe to call repeatedly. */
export async function seedReference(ctx: E2EContext, directory = DATA_DIR) {
  const models = {
    countries: ctx.conn.models.Country ?? ctx.conn.model('Country', CountrySchema),
    cities: ctx.conn.models.City ?? ctx.conn.model('City', CitySchema),
    airports: ctx.conn.models.Airport ?? ctx.conn.model('Airport', AirportSchema),
    attractions: ctx.conn.models.Attraction ?? ctx.conn.model('Attraction', AttractionSchema),
  } as unknown as Record<DatasetKey, Model<any>>;
  for (const key of IMPORT_ORDER) await models[key].syncIndexes();
  const store: ReferenceStore = {
    async upsert(dataset: DatasetKey, keyField, docs) {
      const result = await models[dataset].bulkWrite(
        docs.map((doc) => ({ updateOne: { filter: { [keyField]: doc[keyField] }, update: { $set: doc }, upsert: true } })),
        { ordered: true },
      );
      return { inserted: result.upsertedCount, updated: result.modifiedCount, unchanged: docs.length - result.upsertedCount - result.modifiedCount };
    },
  };
  return importReferenceData(await readDatasets(directory), store);
}
