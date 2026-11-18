import type { Connection } from 'mongoose';
import { Types } from 'mongoose';

import { SEED_TAG } from './demo-seed.constants';

export interface ManifestEntry {
  tag: string;
  key: string;
  collection: string;
  docId: Types.ObjectId;
}

/**
 * The list of every document the demo seed created, kept in its own collection (`seed_manifest`).
 * `--reset` deletes exactly these documents and what depends on them; nothing else.
 * The schemas of the application are not touched: the marker lives here, not on the documents.
 */
export class SeedManifest {
  static readonly COLLECTION = 'seed_manifest';

  constructor(private readonly connection: Connection) {}

  private get collection() {
    return this.connection.collection<ManifestEntry>(SeedManifest.COLLECTION);
  }

  async ensureIndex(): Promise<void> {
    await this.collection.createIndex({ tag: 1, key: 1 }, { unique: true });
  }

  async find(key: string): Promise<ManifestEntry | null> {
    return this.collection.findOne({ tag: SEED_TAG, key });
  }

  async track(key: string, collection: string, docId: Types.ObjectId): Promise<void> {
    await this.collection.updateOne({ tag: SEED_TAG, key }, { $set: { collection, docId } }, { upsert: true });
  }

  async forget(key: string): Promise<void> {
    await this.collection.deleteOne({ tag: SEED_TAG, key });
  }

  async all(): Promise<ManifestEntry[]> {
    return this.collection.find({ tag: SEED_TAG }).toArray();
  }

  async idsOf(collection: string): Promise<Types.ObjectId[]> {
    return (await this.all()).filter((entry) => entry.collection === collection).map((entry) => entry.docId);
  }

  async clear(): Promise<void> {
    await this.collection.deleteMany({ tag: SEED_TAG });
  }
}
