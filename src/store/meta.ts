import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'ts5';
import { STORE_SCHEMA_VERSION } from './schema.js';
import type { ConfiguredProjects } from '../ts7/projects.js';

export interface IndexedFileMeta {
  size: number;
  mtimeMs: number;
}

export interface StoreMetadata {
  schemaVersion: number;
  tsVersion: string;
  tsymBuild: string;
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

export function writeMetadata(storePath: string, metadata: StoreMetadata): void {
  if (metadata.schemaVersion !== STORE_SCHEMA_VERSION) throw new Error(`Store metadata schema version must be ${STORE_SCHEMA_VERSION}.`);
  mkdirSync(storePath, { recursive: true, mode: 0o700 });
  const target = metadataPath(storePath);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

/** Captures every input whose change can alter the configured-program graph. */
export function metadataFor(root: string, projects: ConfiguredProjects, indexedCommit: string, indexDurationMs = 0, tsVersion = bundledTsVersion()): StoreMetadata {
  const configs = [...new Set(projects.records().map((project) => path.resolve(project.config)))].sort();
  const shapeConfigs = inheritedConfigs(configs);
  const files = [...new Set(projects.records().flatMap((project) => [...project.files]))].sort();
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    tsVersion,
    tsymBuild: hashTsymBuild(),
    indexedCommit,
    configSet: configs.map((file) => relative(root, file)),
    configHashes: Object.fromEntries(shapeConfigs.map((file) => [relative(root, file), hashFile(file)])),
    packageHash: hashOptional(path.join(root, 'package.json')),
    lockfileHash: lockfiles.map((name) => `${name}:${hashOptional(path.join(root, name))}`).join('|'),
    indexDurationMs,
    files: Object.fromEntries(files.map((file) => {
      const stat = statSync(file);
      return [relative(root, file), { size: stat.size, mtimeMs: stat.mtimeMs }];
    })),
  };
}

/** A persisted store can be rehydrated only when its schema, program shape, and checkpoint still match. */
export function canReuse(metadata: StoreMetadata | null, expected: StoreMetadata): boolean {
  return metadata !== null && JSON.stringify(shapeOf(metadata)) === JSON.stringify(shapeOf(expected));
}

/** Source changes do not invalidate the graph shape; startup rehydrates then performs the ordinary refresh. */
export function hasSourceDrift(metadata: StoreMetadata, expected: StoreMetadata): boolean {
  return JSON.stringify(metadata.files) !== JSON.stringify(expected.files);
}

function shapeOf(metadata: StoreMetadata): Omit<StoreMetadata, 'files' | 'indexDurationMs'> {
  const { files: _files, indexDurationMs: _duration, ...shape } = metadata;
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
