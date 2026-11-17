import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATASETS, DatasetKey, IMPORT_ORDER, ParsedCsv, PreparedReferenceData, ReferenceImportError, RowIssue, parseCsv, prepareReferenceData } from './reference-data.prepare';

export interface UpsertResult { inserted: number; updated: number; unchanged: number }

/** Storage port: upsert documents keyed by the dataset identifier field. */
export interface ReferenceStore {
  upsert(dataset: DatasetKey, keyField: string, docs: Array<Record<string, unknown>>): Promise<UpsertResult>;
}

export const KEY_FIELDS: Record<DatasetKey, string> = {
  countries: 'code',
  cities: 'cityId',
  airports: 'iataCode',
  attractions: 'attractionId',
};

export interface DatasetSummary extends UpsertResult { file: string; skipped: number }
export interface ImportSummary { datasets: Record<DatasetKey, DatasetSummary>; issues: RowIssue[] }

export async function readDatasets(directory: string): Promise<Record<DatasetKey, ParsedCsv>> {
  const out = {} as Record<DatasetKey, ParsedCsv>;
  for (const key of IMPORT_ORDER) {
    const path = join(directory, DATASETS[key].file);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new ReferenceImportError(`${DATASETS[key].file}: cannot read file at ${path}`);
    }
    try {
      out[key] = parseCsv(text);
    } catch (error) {
      throw new ReferenceImportError(`${DATASETS[key].file}: ${error instanceof Error ? error.message : 'cannot parse CSV'}`);
    }
  }
  return out;
}

/** Validates everything first (so a bad header writes nothing), then upserts in order: countries, cities, airports, attractions. */
export async function importReferenceData(parsed: Record<DatasetKey, ParsedCsv>, store: ReferenceStore): Promise<ImportSummary> {
  const prepared: PreparedReferenceData = prepareReferenceData(parsed);
  const datasets = {} as Record<DatasetKey, DatasetSummary>;
  for (const key of IMPORT_ORDER) {
    const docs = prepared[key] as unknown as Array<Record<string, unknown>>;
    const result = docs.length ? await store.upsert(key, KEY_FIELDS[key], docs) : { inserted: 0, updated: 0, unchanged: 0 };
    datasets[key] = { file: DATASETS[key].file, skipped: prepared.issues.filter((i) => i.file === DATASETS[key].file).length, ...result };
  }
  return { datasets, issues: prepared.issues };
}

export function formatSummary(summary: ImportSummary): string {
  const lines: string[] = [];
  for (const issue of summary.issues) lines.push(`  SKIPPED ${issue.file}:${issue.line} - ${issue.message}`);
  lines.push('Reference import summary:');
  for (const key of IMPORT_ORDER) {
    const s = summary.datasets[key];
    lines.push(`  ${s.file.padEnd(16)} inserted ${s.inserted}, updated ${s.updated}, unchanged ${s.unchanged}, skipped ${s.skipped}`);
  }
  return lines.join('\n');
}
