import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixture = path.resolve('test/fixture');

function run(cache: string, ...args: string[]) {
  return runAt(fixture, cache, args);
}

function runAt(root: string, cache: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache, ...env } });
}

test('resident exits after its workspace root is deleted', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-test-'));
  const root = path.join(temporary, 'fixture');
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-test-'));
  cpSync(fixture, root, { recursive: true });
  try {
    const invoke = runAt(root, cache, ['outline'], { TSYM_IDLE_SECONDS: '2' });
    assert.equal(invoke.status, 0, invoke.stderr);
    const status = runAt(root, cache, ['server', 'status'], { TSYM_IDLE_SECONDS: '2' });
    assert.equal(status.status, 0, status.stderr);
    const port = /port="([^"]+)"/.exec(status.stdout)?.[1];
    const log = /log="([^"]+)"/.exec(status.stdout)?.[1];
    const pid = Number(/pid="(\d+)"/.exec(status.stdout)?.[1]);
    assert.ok(port);
    assert.ok(log);
    assert.ok(Number.isSafeInteger(pid));
    const stopped = endpointRemoved(port, 20_000);
    rmSync(root, { recursive: true, force: true });
    await stopped;
    await processExited(pid, 20_000);
    assert.ok(!existsSync(port));
    assert.equal((readFileSync(log, 'utf8').match(/workspace root disappeared; stopping resident/g) ?? []).length, 1);
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('resident status, lazy start, and stop use a private cache', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-test-'));
  try {
    const stopped = run(cache, 'server', 'status');
    assert.equal(stopped.status, 1);
    assert.match(stopped.stdout, /state="stopped"/);

    const invoke = run(cache, 'outline');
    assert.equal(invoke.status, 0, 'the first semantic call starts the resident and answers');
    assert.match(invoke.stdout, /<outline path="\." /);
    assert.match(invoke.stderr, /\(server started, \d+ ms\)/);

    const warm = run(cache, 'outline');
    assert.equal(warm.status, 0);
    assert.doesNotMatch(warm.stderr, /server started/);

    const reload = run(cache, 'server', 'reload');
    assert.equal(reload.status, 0);
    assert.match(reload.stderr, /\(server started, \d+ ms\)/);

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

async function processExited(pid: number, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`resident ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function endpointRemoved(port: string, timeout = 5_000): Promise<void> {
  if (!existsSync(port)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(port), () => {
      if (!existsSync(port)) { watcher.close(); resolve(); }
    });
    setTimeout(() => { watcher.close(); reject(new Error('resident did not remove its endpoint')); }, timeout).unref();
  });
}
