import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'ts5';
import { STORE_SCHEMA_VERSION } from './schema.js';
import { engineVersion } from './store.js';
import type { ConfiguredProjects } from '../ts7/projects.js';

export type IndexedFileMeta = string;

export interface StoreMetadata {
  schemaVersion: number;
  tsVersion: string;
  engineVersion: string;
  tsymBuild: string;
  root: string;
  indexedCommit: string;
  configSet: string[];
  configHashes: Record<string, string>;
  packageHash: string;
  lockfileHash: string;
  /** Duration of the index operation that wrote this metadata; reported by `server status` after a reuse. */
  indexDurationMs: number;
  files: Record<string, IndexedFileMeta>;
}

const META_FILE = 'meta.json';
const lockfiles = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];

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

/** A store this build cannot read, or without readable metadata, is deleted so the next build starts from nothing. */
export function discardIncompatibleStore(storePath: string, identity: StoreFormatIdentity): boolean {
  if (!existsSync(storePath)) return false;
  let metadata: StoreMetadata | null = null;
  try { metadata = readMetadata(storePath); } catch { metadata = null; }
  if (metadata !== null && sameFormat(metadata, identity)) return false;
  rmSync(storePath, { recursive: true, force: true });
  return true;
}

export function writeMetadata(storePath: string, metadata: StoreMetadata): void {
  if (metadata.schemaVersion !== STORE_SCHEMA_VERSION) throw new Error(`Store metadata schema version must be ${STORE_SCHEMA_VERSION}.`);
  mkdirSync(storePath, { recursive: true, mode: 0o700 });
  const target = metadataPath(storePath);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

/** Captures every input whose change can alter the configured-program graph. */
export interface StoreFormatIdentity { schemaVersion: number; tsVersion: string; engineVersion: string; tsymBuild: string; }

export function formatIdentity(tsVersion = bundledTsVersion()): StoreFormatIdentity {
  return { schemaVersion: STORE_SCHEMA_VERSION, tsVersion, engineVersion: engineVersion(), tsymBuild: hashTsymBuild() };
}

export function metadataFor(root: string, projects: ConfiguredProjects, indexedCommit: string, indexDurationMs = 0, identity = formatIdentity()): StoreMetadata {
  const configs = [...new Set(projects.records().map((project) => path.resolve(project.config)))].sort();
  const shapeConfigs = inheritedConfigs(configs);
  const files = [...new Set(projects.records().flatMap((project) => [...project.files]))].sort();
  return {
    ...identity,
    root,
    indexedCommit,
    configSet: configs.map((file) => relative(root, file)),
    configHashes: Object.fromEntries(shapeConfigs.map((file) => [relative(root, file), hashFile(file)])),
    packageHash: hashOptional(path.join(root, 'package.json')),
    lockfileHash: lockfiles.map((name) => `${name}:${hashOptional(path.join(root, name))}`).join('|'),
    indexDurationMs,
    files: Object.fromEntries(files.map((file) => [relative(root, file), hashFile(file)])),
  };
}

export function hasDrift(metadata: StoreMetadata, expected: StoreMetadata): boolean {
  return JSON.stringify(driftShape(metadata)) !== JSON.stringify(driftShape(expected));
}

export function sameFormat(metadata: Pick<StoreMetadata, 'schemaVersion' | 'tsVersion' | 'engineVersion' | 'tsymBuild'>, identity: StoreFormatIdentity): boolean {
  return metadata.schemaVersion === identity.schemaVersion && metadata.tsVersion === identity.tsVersion && metadata.engineVersion === identity.engineVersion && metadata.tsymBuild === identity.tsymBuild;
}

function driftShape(metadata: StoreMetadata): Omit<StoreMetadata, 'indexedCommit' | 'indexDurationMs'> {
  const { indexedCommit: _commit, indexDurationMs: _duration, ...shape } = metadata;
  return shape;
}

function inheritedConfigs(configs: readonly string[]): string[] {
  const found = new Set<string>();
  const visit = (config: string) => {
    const absolute = path.resolve(config);
    if (found.has(absolute)) return;
    found.add(absolute);
    const result = ts.readConfigFile(absolute, ts.sys.readFile);
    if (result.error || !result.config || typeof result.config.extends !== 'string') return;
    const inherited = resolveExtends(absolute, result.config.extends);
    if (inherited !== undefined) visit(inherited);
  };
  for (const config of configs) visit(config);
  return [...found].sort();
}

function resolveExtends(config: string, extend: string): string | undefined {
  if (extend.startsWith('.') || path.isAbsolute(extend)) {
    const candidate = path.resolve(path.dirname(config), extend);
    const filename = path.extname(candidate) === '' ? `${candidate}.json` : candidate;
    try { statSync(filename); return filename; }
    catch { return undefined; }
  }
  const resolved = (ts as typeof ts & { nodeNextJsonConfigResolver: (moduleName: string, containingFile: string, host: ts.ModuleResolutionHost) => { resolvedModule?: { resolvedFileName: string } } }).nodeNextJsonConfigResolver(extend, path.join(path.dirname(config), 'tsconfig.json'), ts.sys).resolvedModule?.resolvedFileName;
  return resolved === undefined ? undefined : path.resolve(resolved);
}

function bundledTsVersion(): string {
  return createRequire(import.meta.url)('typescript/package.json').version as string;
}

export function hashTsymBuild(dist = path.resolve(fileURLToPath(new URL('../../dist/', import.meta.url)))): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
    }
  };
  visit(dist);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const content = readFileSync(file);
    hash.update(`${path.relative(dist, file).split(path.sep).join('/')}\0${content.byteLength}\0`);
    hash.update(content);
  }
  return hash.digest('hex');
}

function relative(root: string, file: string): string {
  const result = path.relative(root, file);
  return result.startsWith(`..${path.sep}`) || path.isAbsolute(result) ? file : result;
}

function hashOptional(file: string): string {
  try { return hashFile(file); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '<missing>';
    throw error;
  }
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
