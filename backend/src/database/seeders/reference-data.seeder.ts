import { Model, connect, disconnect, model } from 'mongoose';
import { resolve } from 'node:path';
import { AirportSchema } from '../../modules/airports/schemas/airport.schema';
import { AttractionSchema } from '../../modules/reference-data/schemas/attraction.schema';
import { CitySchema } from '../../modules/reference-data/schemas/city.schema';
import { CountrySchema } from '../../modules/reference-data/schemas/country.schema';
import { DatasetKey, IMPORT_ORDER } from './reference-data.prepare';
import { ReferenceStore, formatSummary, importReferenceData, readDatasets } from './reference-import';

/** Usage: npm run seed:reference [-- <directory>]. Default directory: REFERENCE_DATA_DIR or data/reference. */
async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is required (set it in .env)');
  const directory = resolve(process.argv[2] ?? process.env.REFERENCE_DATA_DIR ?? 'data/reference');

  const parsed = await readDatasets(directory);
  await connect(uri);
  const models = {
    countries: model('Country', CountrySchema),
    cities: model('City', CitySchema),
    airports: model('Airport', AirportSchema),
    attractions: model('Attraction', AttractionSchema),
  } as unknown as Record<DatasetKey, Model<any>>;
  // Create the dataset-ID unique indexes and drop obsolete ones (e.g. the old sourceId index) before upserting.
  for (const key of IMPORT_ORDER) await models[key].syncIndexes();

  const store: ReferenceStore = {
    async upsert(dataset: DatasetKey, keyField, docs) {
      const result = await models[dataset].bulkWrite(
        docs.map((doc) => ({ updateOne: { filter: { [keyField]: doc[keyField] }, update: { $set: doc }, upsert: true } })),
        { ordered: true },
      );
      const inserted = result.upsertedCount;
      const updated = result.modifiedCount;
      return { inserted, updated, unchanged: docs.length - inserted - updated };
    },
  };
  console.log(`Importing reference data from ${directory}`);
  console.log(formatSummary(await importReferenceData(parsed, store)));
}

main()
  .catch((error: unknown) => {
    console.error('Reference data import failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  })
  .finally(() => disconnect().catch(() => undefined));
