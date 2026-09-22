import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { idleSeconds, maxResidents } from '../src/server/lifecycle.js';

const fixture = path.resolve('test/fixture');

test('resident lifecycle defaults to twenty idle minutes and three live residents', () => {
  const previousIdle = process.env.TSYM_IDLE_SECONDS;
  const previousCap = process.env.TSYM_MAX_RESIDENTS;
  try {
    delete process.env.TSYM_IDLE_SECONDS;
    delete process.env.TSYM_MAX_RESIDENTS;
    assert.equal(idleSeconds(), 1_200);
    assert.equal(maxResidents(), 3);
    process.env.TSYM_MAX_RESIDENTS = '0';
    assert.equal(maxResidents(), 3);
    process.env.TSYM_MAX_RESIDENTS = '2';
    assert.equal(maxResidents(), 2);
  } finally {
    if (previousIdle === undefined) delete process.env.TSYM_IDLE_SECONDS; else process.env.TSYM_IDLE_SECONDS = previousIdle;
    if (previousCap === undefined) delete process.env.TSYM_MAX_RESIDENTS; else process.env.TSYM_MAX_RESIDENTS = previousCap;
  }
});

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
    const invoke = runAt(root, cache, ['outline'], { TSYM_IDLE_SECONDS: '60' });
    assert.equal(invoke.status, 0, invoke.stderr);
    const status = runAt(root, cache, ['server', 'status'], { TSYM_IDLE_SECONDS: '60' });
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

test('a fresh root seeds from an indexed sibling and reports its source', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-seed-'));
  const source = path.join(temporary, 'source');
  const destination = path.join(temporary, 'destination');
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-seed-cache-'));
  cpSync(fixture, source, { recursive: true });
  cpSync(fixture, destination, { recursive: true });
  try {
    const indexed = runAt(source, cache, ['outline']);
    assert.equal(indexed.status, 0, indexed.stderr);
    const seeded = runAt(destination, cache, ['outline']);
    assert.equal(seeded.status, 0, seeded.stderr);
    const status = runAt(destination, cache, ['server', 'status']);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /seededFrom="[^"]+\/source"/);
    const log = /log="([^"]+)"/.exec(status.stdout)?.[1];
    assert.ok(log);
    assert.match(readFileSync(log, 'utf8'), /store seeded from .+\/source bytes=/);
  } finally {
    runAt(source, cache, ['server', 'stop']);
    runAt(destination, cache, ['server', 'stop']);
    rmSync(cache, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('a fresh root seeds from a dormant sibling and the sibling can start again', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-seed-dormant-'));
  const source = path.join(temporary, 'source');
  const destination = path.join(temporary, 'destination');
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-seed-cache-'));
  cpSync(fixture, source, { recursive: true });
  cpSync(fixture, destination, { recursive: true });
  try {
    assert.equal(runAt(source, cache, ['outline']).status, 0);
    await stopResident(source, cache);
    const seeded = runAt(destination, cache, ['outline']);
    assert.equal(seeded.status, 0, seeded.stderr);
    const status = runAt(destination, cache, ['server', 'status']);
    assert.match(status.stdout, /seededFrom="[^"]+\/source"/);
    const restarted = runAt(source, cache, ['outline']);
    assert.equal(restarted.status, 0, restarted.stderr);
  } finally {
    runAt(source, cache, ['server', 'stop']);
    runAt(destination, cache, ['server', 'stop']);
    rmSync(cache, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('a sibling with one differing file is refused and the destination cold-builds', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-seed-distant-'));
  const source = path.join(temporary, 'source');
  const destination = path.join(temporary, 'destination');
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-seed-cache-'));
  cpSync(fixture, source, { recursive: true });
  cpSync(fixture, destination, { recursive: true });
  try {
    assert.equal(runAt(source, cache, ['outline']).status, 0);
    const file = readdirSync(path.join(destination, 'src')).find((entry) => entry.endsWith('.ts'));
    assert.ok(file);
    writeFileSync(path.join(destination, 'src', file), `${readFileSync(path.join(destination, 'src', file), 'utf8')}\n// distinct sibling\n`);
    const started = runAt(destination, cache, ['outline']);
    assert.equal(started.status, 0, started.stderr);
    const status = runAt(destination, cache, ['server', 'status']);
    assert.doesNotMatch(status.stdout, /seededFrom=/);
    const log = /log="([^"]+)"/.exec(status.stdout)?.[1];
    assert.ok(log);
    assert.match(readFileSync(log, 'utf8'), /store seed skipped: no identical sibling/);
  } finally {
    runAt(source, cache, ['server', 'stop']);
    runAt(destination, cache, ['server', 'stop']);
    rmSync(cache, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('a leftover interrupted seed is removed before a cold build', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-seed-interrupted-'));
  const root = path.join(temporary, 'destination');
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-seed-cache-'));
  cpSync(fixture, root, { recursive: true });
  try {
    const state = path.join(cache, 'tsym', createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16));
    const interrupted = path.join(state, 'store.seed');
    mkdirSync(interrupted, { recursive: true });
    writeFileSync(path.join(interrupted, 'graph.lbug'), 'partial');
    const started = runAt(root, cache, ['outline']);
    assert.equal(started.status, 0, started.stderr);
    assert.ok(!existsSync(interrupted));
    assert.ok(existsSync(path.join(state, 'store', 'meta.json')));
    assert.ok(existsSync(path.join(state, 'store', 'graph.lbug')));
  } finally {
    runAt(root, cache, ['server', 'stop']);
    rmSync(cache, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('server reload rebuilds an empty root without seeding', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-seed-rebuild-'));
  const source = path.join(temporary, 'source');
  const destination = path.join(temporary, 'destination');
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-seed-cache-'));
  cpSync(fixture, source, { recursive: true });
  cpSync(fixture, destination, { recursive: true });
  try {
    assert.equal(runAt(source, cache, ['outline']).status, 0);
    const reloaded = runAt(destination, cache, ['server', 'reload']);
    assert.equal(reloaded.status, 0, reloaded.stderr);
    const status = runAt(destination, cache, ['server', 'status']);
    assert.doesNotMatch(status.stdout, /seededFrom=/);
    const log = /log="([^"]+)"/.exec(status.stdout)?.[1];
    assert.ok(log);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /store seeded from/);
  } finally {
    runAt(source, cache, ['server', 'stop']);
    runAt(destination, cache, ['server', 'stop']);
    rmSync(cache, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('a branch switch refreshes files instead of cold-building and ignores commit provenance for identical content', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-branch-switch-'));
  const root = path.join(temporary, 'fixture');
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-branch-cache-'));
  cpSync(fixture, root, { recursive: true });
  try {
    git(root, ['init']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'A']);
    const commitA = git(root, ['rev-parse', 'HEAD']).trim();
    assert.equal(runAt(root, cache, ['outline']).status, 0);
    await stopResident(root, cache);
    git(root, ['checkout', '-b', 'topic']);
    const changed = path.join(root, 'src', 'greet.ts');
    const textB = `${readFileSync(changed, 'utf8')}\nexport const topic = true;\n`;
    writeFileSync(changed, textB);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'B']);
    const commitB = git(root, ['rev-parse', 'HEAD']).trim();
    const refreshed = runAt(root, cache, ['outline']);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    let status = runAt(root, cache, ['server', 'status']);
    assert.match(status.stdout, new RegExp(`indexedCommit="${commitB}"`));
    const log = /log="([^"]+)"/.exec(status.stdout)?.[1];
    assert.ok(log);
    assert.match(readFileSync(log, 'utf8'), /index refresh stored=files/);
    await stopResident(root, cache);
    git(root, ['checkout', commitA]);
    writeFileSync(changed, textB);
    const reused = runAt(root, cache, ['outline']);
    assert.equal(reused.status, 0, reused.stderr);
    status = runAt(root, cache, ['server', 'status']);
    assert.match(status.stdout, new RegExp(`indexedCommit="${commitB}"`));
    assert.equal((readFileSync(log, 'utf8').match(/index refresh stored=/g) ?? []).length, 1);
  } finally {
    runAt(root, cache, ['server', 'stop']);
    rmSync(cache, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('starting a fourth resident evicts the least recently queried resident', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-resident-cap-'));
  const roots = ['first', 'second', 'third', 'fourth'].map((name) => path.join(temporary, name));
  const scratch = path.join(process.env.HOME ?? tmpdir(), '.crouter', 'canvas', 'scratch');
  mkdirSync(scratch, { recursive: true });
  const cache = mkdtempSync(path.join(scratch, 'tsym-resident-cap-'));
  try {
    for (const root of roots) cpSync(fixture, root, { recursive: true });
    for (const root of roots.slice(0, 3)) assert.equal(runAt(root, cache, ['outline'], { TSYM_MAX_RESIDENTS: '3' }).status, 0);
    assert.equal(runAt(roots[0]!, cache, ['outline'], { TSYM_MAX_RESIDENTS: '3' }).status, 0, 'the first resident becomes most recently queried');
    const fourth = runAt(roots[3]!, cache, ['outline'], { TSYM_MAX_RESIDENTS: '3' });
    assert.equal(fourth.status, 0, fourth.stderr);
    assert.match(runAt(roots[0]!, cache, ['server', 'status'], { TSYM_MAX_RESIDENTS: '3' }).stdout, /state="ready"/);
    assert.match(runAt(roots[1]!, cache, ['server', 'status'], { TSYM_MAX_RESIDENTS: '3' }).stdout, /state="stopped"/);
    assert.match(runAt(roots[2]!, cache, ['server', 'status'], { TSYM_MAX_RESIDENTS: '3' }).stdout, /state="ready"/);
    const status = runAt(roots[3]!, cache, ['server', 'status'], { TSYM_MAX_RESIDENTS: '3' });
    assert.match(status.stdout, /state="ready"/);
    assert.match(status.stdout, /maxResidents="3"/);
  } finally {
    for (const root of roots) runAt(root, cache, ['server', 'stop'], { TSYM_MAX_RESIDENTS: '3' });
    rmSync(cache, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('a cap eviction lets the active request complete before stopping its resident', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-resident-busy-'));
  const source = path.join(temporary, 'source');
  const destination = path.join(temporary, 'destination');
  const scratch = path.join(process.env.HOME ?? tmpdir(), '.crouter', 'canvas', 'scratch');
  mkdirSync(scratch, { recursive: true });
  const cache = mkdtempSync(path.join(scratch, 'tsym-resident-busy-cache-'));
  let resident: ReturnType<typeof spawn> | undefined;
  try {
    cpSync(fixture, source, { recursive: true });
    cpSync(fixture, destination, { recursive: true });
    const port = path.join(cache, 'tsym', createHash('sha256').update(realpathSync(source)).digest('hex').slice(0, 16), 'port');
    resident = spawn(process.execPath, ['dist/server/main.js', '--root', source], { cwd: process.cwd(), detached: true, stdio: 'ignore', env: { ...process.env, XDG_CACHE_HOME: cache, TSYM_MAX_RESIDENTS: '1' } });
    resident.unref();
    await endpointCreated(port);
    const invocation = invokeUntilProjectLoad(port, realpathSync(source));
    await invocation.started;
    const started = runAt(destination, cache, ['outline'], { TSYM_MAX_RESIDENTS: '1' });
    assert.equal(started.status, 0, started.stderr);
    const completion = await invocation.completed;
    assert.ok('answer' in completion && completion.answer, 'the active request must answer before its resident stops');
    assert.match(runAt(source, cache, ['server', 'status'], { TSYM_MAX_RESIDENTS: '1' }).stdout, /state="stopped"/);
  } finally {
    runAt(source, cache, ['server', 'stop'], { TSYM_MAX_RESIDENTS: '1' });
    runAt(destination, cache, ['server', 'stop'], { TSYM_MAX_RESIDENTS: '1' });
    resident?.kill('SIGTERM');
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

function invokeUntilProjectLoad(port: string, root: string): { started: Promise<void>; completed: Promise<{ answer?: unknown; error?: unknown }> } {
  const socket = connect(port);
  let buffered = '';
  let start = () => {};
  let finish = (_completion: { answer?: unknown; error?: unknown }) => {};
  const started = new Promise<void>((resolve) => { start = resolve; });
  const completed = new Promise<{ answer?: unknown; error?: unknown }>((resolve, reject) => {
    finish = resolve;
    socket.on('error', reject);
  });
  socket.on('connect', () => socket.write(`${JSON.stringify({ version: 1, requestId: 'busy-request', root, operation: 'invoke', invocation: { path: ['outline'], cwd: root, args: [], flags: { '--depth': 1 }, explicit: [] } })}\n`));
  socket.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) {
      const frame = JSON.parse(line) as { type: string; phase?: string; completion?: { answer?: unknown; error?: unknown } };
      if (frame.type === 'phase' && frame.phase === 'project-load-start') start();
      if (frame.type === 'response' && frame.completion) { finish(frame.completion); socket.end(); }
    }
  });
  return { started, completed };
}

async function endpointCreated(port: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!existsSync(port)) {
    if (Date.now() >= deadline) throw new Error('resident did not create its endpoint');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function stopResident(root: string, cache: string): Promise<void> {
  const status = runAt(root, cache, ['server', 'status']);
  assert.equal(status.status, 0, status.stderr);
  const port = /port="([^"]+)"/.exec(status.stdout)?.[1];
  assert.ok(port);
  const stopped = endpointRemoved(port, 20_000);
  const result = runAt(root, cache, ['server', 'stop']);
  assert.equal(result.status, 0, result.stderr);
  await stopped;
}

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
