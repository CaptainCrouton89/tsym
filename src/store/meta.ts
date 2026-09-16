import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STORE_SCHEMA_VERSION } from './schema.js';

export interface IndexedFileMeta {
  size: number;
  mtimeMs: number;
}

export interface StoreMetadata {
  schemaVersion: number;
  tsVersion: string;
  indexedCommit: string;
  configSet: string[];
  configHashes: Record<string, string>;
  packageHash: string;
  lockfileHash: string;
  files: Record<string, IndexedFileMeta>;
}

const META_FILE = 'meta.json';

export function metadataPath(storePath: string): string {
  return path.join(storePath, META_FILE);
}

export function readMetadata(storePath: string): StoreMetadata | null {
  try { return JSON.parse(readFileSync(metadataPath(storePath), 'utf8')) as StoreMetadata; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function writeMetadata(storePath: string, metadata: StoreMetadata): void {
  if (metadata.schemaVersion !== STORE_SCHEMA_VERSION) throw new Error(`Store metadata schema version must be ${STORE_SCHEMA_VERSION}.`);
  mkdirSync(storePath, { recursive: true, mode: 0o700 });
  const target = metadataPath(storePath);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}
