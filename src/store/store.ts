import { Connection, Database, type LbugValue, type QueryResult } from '@ladybugdb/core';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NODE_TABLES, RELATION_TABLES, SCHEMA_STATEMENTS } from './schema.js';

const ownedStores = new Set<string>();

export class StoreOwnershipError extends Error {
  constructor(readonly storePath: string, readonly ownerPid?: number) {
    super(ownerPid === undefined ? `The tsym store at ${storePath} is already open in this process.` : `The tsym store at ${storePath} is owned by process ${ownerPid}.`);
    this.name = 'StoreOwnershipError';
  }
}

export type StoreRow = Record<string, LbugValue>;

export class Store {
  readonly path: string;
  private readonly ownerPath: string;
  private readonly database: Database;
  private readonly connection: Connection;
  private closed = false;

  constructor(storePath: string) {
    this.path = path.resolve(storePath);
    this.ownerPath = path.join(this.path, '.tsym-owner');
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    acquireOwnership(this.path, this.ownerPath);
    try {
      this.database = new Database(path.join(this.path, 'graph.lbug'));
      this.database.initSync();
      this.connection = new Connection(this.database);
      this.connection.initSync();
      const tables = new Set(this.execute('CALL SHOW_TABLES() RETURN *').map((row) => row.name));
      const expected = [...NODE_TABLES, ...RELATION_TABLES].map(tableName);
      if (tables.size === 0) this.transaction(() => { for (const statement of SCHEMA_STATEMENTS) this.execute(statement); });
      else if (!expected.every((name) => tables.has(name))) throw new Error(`Store schema is incomplete at ${this.path}.`);
    } catch (error) {
      releaseOwnership(this.path, this.ownerPath);
      throw error;
    }
  }

  execute(statement: string, parameters?: Record<string, LbugValue>): StoreRow[] {
    this.assertOpen();
    const result = parameters === undefined
      ? this.connection.querySync(statement)
      : this.connection.executeSync(this.connection.prepareSync(statement), parameters);
    return collect(result);
  }

  transaction<T>(work: () => T): T {
    this.execute('BEGIN TRANSACTION');
    try {
      const value = work();
      this.execute('COMMIT');
      return value;
    } catch (error) {
      try { this.execute('ROLLBACK'); } catch {}
      throw error;
    }
  }

  checkpoint(): void {
    this.execute('CHECKPOINT');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.connection.closeSync(); } finally {
      try { this.database.closeSync(); } finally { releaseOwnership(this.path, this.ownerPath); }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Store is closed.');
  }
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
    try { rows.push(...item.getAllSync()); } finally { item.close(); }
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
