import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { type ServerPaths, pathsForRoot } from '../server/lifecycle.js';
import { NdjsonReader, WIRE_VERSION, type ResponseFrame, writeFrame } from '../server/wire.js';
import { changedFiles, readMetadata, sameFormat, writeMetadata, type StoreFormatIdentity, type StoreMetadata } from './meta.js';

interface Candidate { root: string; store: string; metadata: StoreMetadata; }
export interface SeedReceipt { root: string; bytes: number; durationMs: number; }

/** Finds compatible sibling stores and installs one only after a complete copy validates. */
export async function seedFromSibling(root: string, paths: ServerPaths, expected: StoreMetadata, identity: StoreFormatIdentity): Promise<SeedReceipt | undefined> {
  const started = performance.now();
  // A process that died mid-copy on a previous start leaves this behind; it is never valid to keep across a start.
  rmSync(seedPath(paths), { recursive: true, force: true });
  for (const candidate of siblings(root, paths, expected, identity)) {
    try {
      const copied = copyWhileLocked(candidate, paths) || await copyFromOwner(candidate, paths);
      if (!copied) continue;
      const copiedMetadata = readMetadata(seedPath(paths));
      if (copiedMetadata === null || copiedMetadata.root !== candidate.root || !sameFormat(copiedMetadata, identity)) throw new Error('copied metadata did not match the selected sibling');
      writeMetadata(seedPath(paths), { ...copiedMetadata, root });
      rmSync(paths.store, { recursive: true, force: true });
      renameSync(seedPath(paths), paths.store);
      return { root: candidate.root, bytes: directoryBytes(paths.store), durationMs: performance.now() - started };
    } catch {
      rmSync(seedPath(paths), { recursive: true, force: true });
    }
  }
  return undefined;
}

/** Copies a resident's store after the owner checkpointed it. The owner excludes its process-local marker. */
export function copyStore(source: string, destination: string): number {
  if (existsSync(destination)) throw new Error(`Seed destination already exists: ${destination}.`);
  cpSync(source, destination, { recursive: true, filter: (entry) => path.basename(entry) !== '.tsym-owner' });
  return directoryBytes(destination);
}

/** Returns the wire refusal reason, keeping the owner’s destination safety contract testable. */
export function refuseSeed(dest: unknown, cacheBase: string, bootstrapped: boolean, busy: boolean): string | undefined {
  if (!bootstrapped) return 'The resident has not bootstrapped a store.';
  if (busy) return 'The resident is writing its store.';
  if (typeof dest !== 'string' || !inside(cacheBase, dest) || existsSync(dest)) return 'The seed destination must be a new directory inside the tsym cache.';
  return undefined;
}

function siblings(root: string, paths: ServerPaths, expected: StoreMetadata, identity: StoreFormatIdentity): Candidate[] {
  const candidates: Candidate[] = [];
  const base = path.dirname(paths.state);
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const store = path.join(base, entry.name, 'store');
    let metadata: StoreMetadata | null;
    try { metadata = readMetadata(store); } catch { continue; }
    if (metadata === null || metadata.root === root || !sameFormat(metadata, identity)) continue;
    if (changedFiles(metadata, expected) !== 0) continue;
    candidates.push({ root: metadata.root, store, metadata });
  }
  return candidates;
}

function copyWhileLocked(candidate: Candidate, paths: ServerPaths): boolean {
  let lock: DatabaseSync | undefined;
  try {
    lock = new DatabaseSync(pathsForRoot(candidate.root).lock);
    lock.exec('BEGIN EXCLUSIVE');
    copyStore(candidate.store, seedPath(paths));
    return true;
  } catch (error) {
    if (!isBusy(error)) throw error;
    return false;
  } finally { try { lock?.close(); } catch {} }
}

async function copyFromOwner(candidate: Candidate, paths: ServerPaths): Promise<boolean> {
  const destination = seedPath(paths);
  const sourcePaths = pathsForRoot(candidate.root);
  try {
    const response = await requestSeed(sourcePaths.port, candidate.root, destination);
    return response.root === candidate.root && response.store === destination;
  } catch { return false; }
}

function requestSeed(port: string, root: string, dest: string): Promise<{ root: string; store: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port);
    const reader = new NdjsonReader();
    const requestId = randomUUID();
    const timer = setTimeout(() => fail(new Error('seed request timed out')), 30_000);
    let settled = false;
    const finish = (value: { root: string; store: string }) => { if (!settled) { settled = true; clearTimeout(timer); socket.end(); resolve(value); } };
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); reject(error); } };
    socket.on('connect', () => writeFrame(socket, { version: WIRE_VERSION, requestId, root, operation: 'seed', seed: { dest } }));
    socket.on('data', (chunk) => {
      for (const value of reader.push(chunk)) {
        const frame = value as ResponseFrame;
        if (frame.type !== 'response' || frame.requestId !== requestId) continue;
        const answer = frame.completion.answer;
        const data = answer?.data;
        const node = Array.isArray(data) ? data[0] : data;
        if (node?.element === 'seed' && typeof node.attributes?.root === 'string' && typeof node.attributes.store === 'string') finish({ root: node.attributes.root, store: node.attributes.store });
        else fail(new Error('seed request was refused'));
      }
    });
    socket.on('error', fail);
    socket.on('close', () => { if (!settled) fail(new Error('seed owner closed without responding')); });
  });
}

function seedPath(paths: ServerPaths): string { return path.join(paths.state, 'store.seed'); }

function directoryBytes(directory: string): number {
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(file);
    else if (entry.isFile()) bytes += lstatSync(file).size;
  }
  return bytes;
}

function isBusy(error: unknown): boolean { return (error as { code?: string; errcode?: number }).code === 'ERR_SQLITE_ERROR' && (error as { errcode?: number }).errcode === 5 || String(error).includes('database is locked'); }

function inside(parent: string, child: string): boolean {
  try {
    const physicalParent = realpathSync(parent);
    const physicalChild = physicalPath(child);
    const relative = path.relative(physicalParent, physicalChild);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}

function physicalPath(target: string): string {
  const missing: string[] = [];
  let existing = path.resolve(target);
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`No existing ancestor for ${target}.`);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missing);
}
