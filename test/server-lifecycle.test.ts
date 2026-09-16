import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixture = path.resolve('test/fixture');

function run(cache: string, ...args: string[]) {
  return spawnSync(process.execPath, ['dist/cli.js', '--root', fixture, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
}

test('resident status, lazy start, and stop use a private cache', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'symbols-test-'));
  try {
    const stopped = run(cache, 'server', 'status');
    assert.equal(stopped.status, 1);
    assert.match(stopped.stdout, /state="stopped"/);

    const invoke = run(cache, 'outline');
    assert.equal(invoke.status, 0, 'the first semantic call starts the resident and answers');
    assert.match(invoke.stdout, /<outline path="\." /);

    const ready = run(cache, 'server', 'status');
    assert.equal(ready.status, 0);
    assert.match(ready.stdout, /state="ready"/);
    assert.match(ready.stdout, /log=/);

    const port = /port="([^"]+)"/.exec(ready.stdout)?.[1];
    assert.ok(port);
    const stoppedSignal = endpointRemoved(port);
    const stop = run(cache, 'server', 'stop');
    assert.equal(stop.status, 0);
    assert.match(stop.stdout, /state="stopping"/);
    await stoppedSignal;
  } finally {
    run(cache, 'server', 'stop');
    rmSync(cache, { recursive: true, force: true });
  }
});

function endpointRemoved(port: string): Promise<void> {
  if (!existsSync(port)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(port), () => {
      if (!existsSync(port)) { watcher.close(); resolve(); }
    });
    setTimeout(() => { watcher.close(); reject(new Error('resident did not remove its endpoint')); }, 5_000).unref();
  });
}
