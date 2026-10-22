import type { Connection, Database, LbugValue, QueryResult } from '@ladybugdb/core';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NODE_TABLES, RELATION_TABLES, SCHEMA_STATEMENTS } from './schema.js';

const ownedStores = new Set<string>();
const DEFAULT_BOUNDED_QUERY_TIMEOUT_MS = 30_000;
const ENGINE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];
const require = createRequire(import.meta.url);

export class EngineBinaryError extends Error {
  readonly code = 'no-engine-binary';
  readonly platform: string;

  constructor(platform = `${process.platform}-${process.arch}`) {
    super(`LadybugDB has no prebuilt binary for ${platform}, and tsym does not compile it.\nPrebuilt platforms: ${ENGINE_PLATFORMS.join(', ')}.`);
    this.platform = platform;
  }
}

/** The store at `storePath` was corrupt and could not be replaced. `preserved` is where the corrupt copy was moved; it is undefined when the move itself failed and the corrupt store is still at `storePath`. */
export class StoreRecoveryError extends Error {
  readonly reason: string;

  constructor(readonly storePath: string, readonly preserved: string | undefined, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(preserved === undefined
      ? `The tsym store at ${storePath} was corrupt and could not be moved aside: ${reason}`
      : `The tsym store at ${storePath} was corrupt (preserved at ${preserved}) and its replacement failed: ${reason}`);
    this.reason = reason;
    this.name = 'StoreRecoveryError';
  }
}

export interface StoreOptions {
  boundedQueryTimeoutMs?: number;
}

export class StoreOwnershipError extends Error {
  constructor(readonly storePath: string, readonly ownerPid?: number) {
    super(ownerPid === undefined ? `The tsym store at ${storePath} is already open in this process.` : `The tsym store at ${storePath} is owned by process ${ownerPid}.`);
    this.name = 'StoreOwnershipError';
  }
}

export class StoreReadOnlyError extends Error {
  constructor() {
    super('Query statements must be read-only.');
    this.name = 'StoreReadOnlyError';
  }
}

export type StoreRow = Record<string, LbugValue>;

// LadybugDB's WAL replay and checksum failures. Ownership, permission, disk-full, engine-binary and project errors never match.
const WAL_CORRUPTION = /Corrupted wal file|WAL replay encountered|Checksum verification failed, the WAL file is corrupted/i;

export function isWalCorruption(error: unknown): boolean {
  return error instanceof Error && WAL_CORRUPTION.test(error.message);
}

/** The loaded engine's version; part of the store format identity because a graph written by one engine is not reopened by another. */
export function engineVersion(): string {
  return loadEngine().Database.getVersion();
}

/**
 * Opens the store. A WAL-corruption failure moves the whole store directory aside and opens a fresh one, once.
 * `recovered` names the preserved directory when that happened; the caller must then rebuild the index from nothing.
 */
export function openStore(storePath: string, log: (message: string) => void): { store: Store; recovered?: { preserved: string } } {
  try { return { store: new Store(storePath) }; }
  catch (error) {
    if (!isWalCorruption(error)) throw error;
    const preserved = `${path.resolve(storePath)}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    log(`store open failed with WAL corruption: ${error instanceof Error ? error.message : String(error)}`);
    try { renameSync(storePath, preserved); }
    catch (renameError) { throw new StoreRecoveryError(storePath, undefined, renameError); }
    log(`corrupt store preserved at ${preserved}`);
    try { return { store: new Store(storePath), recovered: { preserved } }; }
    catch (reopenError) { throw new StoreRecoveryError(storePath, preserved, reopenError); }
  }
}

export class Store {
  readonly path: string;
  private readonly ownerPath: string;
  private database: Database | undefined;
  private connection: Connection | undefined;
  private boundedConnection: Connection | undefined;
  private closed = false;
  private readonly boundedQueryTimeoutMs: number;
  private writing = false;

  constructor(storePath: string, options: StoreOptions = {}) {
    this.path = path.resolve(storePath);
    this.boundedQueryTimeoutMs = options.boundedQueryTimeoutMs ?? DEFAULT_BOUNDED_QUERY_TIMEOUT_MS;
    this.ownerPath = path.join(this.path, '.tsym-owner');
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    acquireOwnership(this.path, this.ownerPath);
    try {
      const { Database, Connection } = loadEngine();
      this.database = new Database(path.join(this.path, 'graph.lbug'));
      this.database.initSync();
      this.connection = new Connection(this.database);
      this.connection.initSync();
      const tables = new Set(this.execute('CALL SHOW_TABLES() RETURN *').map((row) => row.name));
      const expected = [...NODE_TABLES, ...RELATION_TABLES].map(tableName);
      if (tables.size === 0) this.transaction(() => { for (const statement of SCHEMA_STATEMENTS) this.execute(statement); });
      else if (!expected.every((name) => tables.has(name))) throw new Error(`Store schema is incomplete at ${this.path}.`);
    } catch (error) {
      try { this.connection?.closeSync(); } catch {}
      try { this.database?.closeSync(); } catch {}
      releaseOwnership(this.path, this.ownerPath);
      throw error;
    }
  }

  execute(statement: string, parameters?: Record<string, LbugValue>): StoreRow[] {
    this.assertOpen();
    const connection = this.connection;
    if (connection === undefined) throw new Error('Store did not finish opening.');
    const result = parameters === undefined
      ? connection.querySync(statement)
      : connection.executeSync(connection.prepareSync(statement), parameters);
    return collect(result);
  }

  /** Executes a read query on a separate connection whose 30-second engine timeout never affects writes. */
  executeBounded(statement: string, parameters?: Record<string, LbugValue>): StoreRow[] {
    this.assertOpen();
    const connection = this.bounded();
    const prepared = connection.prepareSync(statement);
    if (!prepared.isSuccess()) throw new Error(prepared.getErrorMessage());
    if (!prepared.isReadOnly()) throw new StoreReadOnlyError();
    return collect(connection.executeSync(prepared, parameters));
  }

  get busy(): boolean { return this.writing; }

  transaction<T>(work: () => T): T {
    if (this.writing) throw new Error('Store transaction is already in progress.');
    this.writing = true;
    try {
      this.execute('BEGIN TRANSACTION');
      const value = work();
      this.execute('COMMIT');
      return value;
    } catch (error) {
      try { this.execute('ROLLBACK'); } catch {}
      throw error;
    } finally { this.writing = false; }
  }

  checkpoint(): void {
    this.execute('CHECKPOINT');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.boundedConnection?.closeSync(); } finally {
      try { this.connection?.closeSync(); } finally {
        try { this.database?.closeSync(); } finally { releaseOwnership(this.path, this.ownerPath); }
      }
    }
  }

  private bounded(): Connection {
    if (this.boundedConnection !== undefined) return this.boundedConnection;
    const database = this.database;
    if (database === undefined) throw new Error('Store did not finish opening.');
    const connection = new (loadEngine().Connection)(database);
    connection.initSync();
    connection.setQueryTimeout(this.boundedQueryTimeoutMs);
    this.boundedConnection = connection;
    return connection;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Store is closed.');
  }
}

function loadEngine(): { Database: (new (file: string) => Database) & { getVersion(): string }; Connection: new (database: Database) => Connection } {
  let entry: string;
  try { entry = require.resolve('@ladybugdb/core'); }
  catch { throw new EngineBinaryError(); }
  if (!existsSync(path.join(path.dirname(entry), 'lbugjs.node'))) throw new EngineBinaryError();
  return require('@ladybugdb/core') as { Database: (new (file: string) => Database) & { getVersion(): string }; Connection: new (database: Database) => Connection };
}

function tableName(statement: string): string {
  const match = /CREATE (?:NODE|REL) TABLE ([A-Za-z_][A-Za-z_]*)/.exec(statement);
  if (!match) throw new Error(`Schema statement has no table name: ${statement}`);
  return match[1];
}

function collect(result: QueryResult | QueryResult[]): StoreRow[] {
  const results = Array.isArray(result) ? result : [result];
  const rows: StoreRow[] = [];
  for (const item of results) {
    try { for (const row of item.getAllSync()) rows.push(row); } finally { item.close(); }
  }
  return rows;
}

function acquireOwnership(storePath: string, ownerPath: string): void {
  if (ownedStores.has(storePath)) throw new StoreOwnershipError(storePath);
  for (;;) {
    try {
      const fd = openSync(ownerPath, 'wx', 0o600);
      try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      ownedStores.add(storePath);
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const ownerPid = readOwnerPid(ownerPath);
      if (ownerPid !== undefined && processAlive(ownerPid)) throw new StoreOwnershipError(storePath, ownerPid);
      try { unlinkSync(ownerPath); } catch (unlinkError: unknown) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
  }
}

function releaseOwnership(storePath: string, ownerPath: string): void {
  ownedStores.delete(storePath);
  try { unlinkSync(ownerPath); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readOwnerPid(ownerPath: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(ownerPath, 'utf8').trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
