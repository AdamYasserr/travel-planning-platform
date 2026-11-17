import { DatasetKey, ParsedCsv, parseCsv } from './reference-data.prepare';
import { ReferenceStore, UpsertResult, formatSummary, importReferenceData } from './reference-import';

/** In-memory store with the same upsert semantics as the Mongo adapter. */
class MemoryStore implements ReferenceStore {
  data: Record<string, Map<string, Record<string, unknown>>> = {};
  order: string[] = [];
  async upsert(dataset: DatasetKey, keyField: string, docs: Array<Record<string, unknown>>): Promise<UpsertResult> {
    this.order.push(dataset);
    const table = (this.data[dataset] ??= new Map());
    const result = { inserted: 0, updated: 0, unchanged: 0 };
    for (const doc of docs) {
      const key = String(doc[keyField]);
      const existing = table.get(key);
      if (!existing) result.inserted++;
      else if (JSON.stringify(existing) !== JSON.stringify(doc)) result.updated++;
      else result.unchanged++;
      table.set(key, { ...doc });
    }
    return result;
  }
}

const input = (): Record<DatasetKey, ParsedCsv> => ({
  countries: parseCsv('code,name,currency\nEG,Egypt,EGP\nFR,France,EUR\n'),
  cities: parseCsv('city_id,name,country_code\ncairo,Cairo,EG\nparis,Paris,FR\n'),
  airports: parseCsv('iata_code,name,city_id,country_code,time_zone\nCAI,Cairo International Airport,cairo,EG,Africa/Cairo\n'),
  attractions: parseCsv('attraction_id,name,city_id\natt-1,Pyramids,cairo\nBAD,,paris\n'),
});

describe('importReferenceData', () => {
  it('imports in order countries, cities, airports, attractions and summarizes', async () => {
    const store = new MemoryStore();
    const summary = await importReferenceData(input(), store);
    expect(store.order).toEqual(['countries', 'cities', 'airports', 'attractions']);
    expect(summary.datasets.countries).toMatchObject({ inserted: 2, updated: 0, unchanged: 0, skipped: 0 });
    expect(summary.datasets.attractions).toMatchObject({ inserted: 1, skipped: 1 });
    expect(formatSummary(summary)).toContain('SKIPPED Attractions.csv:3');
  });

  it('is idempotent: a second run inserts nothing and creates no duplicates', async () => {
    const store = new MemoryStore();
    await importReferenceData(input(), store);
    const second = await importReferenceData(input(), store);
    for (const key of ['countries', 'cities', 'airports', 'attractions'] as DatasetKey[]) {
      expect(second.datasets[key].inserted).toBe(0);
      expect(second.datasets[key].updated).toBe(0);
    }
    expect(store.data.countries.size).toBe(2);
    expect(store.data.airports.size).toBe(1);
  });

  it('updates changed rows in place on re-run', async () => {
    const store = new MemoryStore();
    await importReferenceData(input(), store);
    const changed = input();
    changed.countries = parseCsv('code,name,currency\nEG,Arab Republic of Egypt,EGP\nFR,France,EUR\n');
    const summary = await importReferenceData(changed, store);
    expect(summary.datasets.countries).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
    expect(store.data.countries.get('EG')?.name).toBe('Arab Republic of Egypt');
  });

  it('writes nothing when a header is invalid', async () => {
    const store = new MemoryStore();
    const bad = input();
    bad.cities = parseCsv('id,name,country_code\ncairo,Cairo,EG\n');
    await expect(importReferenceData(bad, store)).rejects.toThrow(/Cities\.csv: missing required column "city_id"/);
    expect(store.order).toEqual([]);
  });
});
