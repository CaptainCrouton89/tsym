import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cacheExpiryMs, sweepExpiredCaches, type ServerPaths } from '../src/server/lifecycle.js';

const DAY = 86_400_000;

function cacheDir(base: string, name: string, ageDays: number, pid?: number): string {
  const directory = path.join(base, name);
  mkdirSync(directory, { recursive: true });
  if (pid !== undefined) writeFileSync(path.join(directory, 'pid'), JSON.stringify({ pid }));
  writeFileSync(path.join(directory, 'used'), '');
  const when = new Date(Date.now() - ageDays * DAY);
  for (const file of ['used', 'pid']) { try { utimesSync(path.join(directory, file), when, when); } catch {} }
  return directory;
}

test('the expiry sweep removes only stale, stopped sibling caches', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'tsym-expiry-'));
  const previous = process.env.TSYM_CACHE_EXPIRY_DAYS;
  try {
    process.env.TSYM_CACHE_EXPIRY_DAYS = '2';
    assert.equal(cacheExpiryMs(), 2 * DAY);
    const own = cacheDir(base, 'own', 30);
    const stale = cacheDir(base, 'stale', 3);
    const fresh = cacheDir(base, 'fresh', 1);
    const running = cacheDir(base, 'running', 30, process.pid);
    const removed = sweepExpiredCaches({ state: own } as ServerPaths);
    assert.deepEqual(removed, [stale]);
    assert.ok(!existsSync(stale));
    for (const kept of [own, fresh, running]) assert.ok(existsSync(kept), `${kept} must survive`);
  } finally {
    if (previous === undefined) delete process.env.TSYM_CACHE_EXPIRY_DAYS; else process.env.TSYM_CACHE_EXPIRY_DAYS = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test('the expiry defaults to 7 days when the variable is unset or invalid', () => {
  const previous = process.env.TSYM_CACHE_EXPIRY_DAYS;
  try {
    delete process.env.TSYM_CACHE_EXPIRY_DAYS;
    assert.equal(cacheExpiryMs(), 7 * DAY);
    process.env.TSYM_CACHE_EXPIRY_DAYS = '0';
    assert.equal(cacheExpiryMs(), 7 * DAY);
  } finally {
    if (previous === undefined) delete process.env.TSYM_CACHE_EXPIRY_DAYS; else process.env.TSYM_CACHE_EXPIRY_DAYS = previous;
  }
});
