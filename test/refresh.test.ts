import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildIndex, type BuiltIndex } from '../src/index/build.js';
import { graphsEqual, refreshIndex } from '../src/index/refresh.js';
import { IndexStateController, type IndexSnapshot } from '../src/index/state.js';
import { watchIndex, type WatchBatch } from '../src/index/watch.js';
import { Store } from '../src/store/store.js';
import { Ts7Host } from '../src/ts7/api.js';
import { ConfiguredProjects } from '../src/ts7/projects.js';

function fixture(): { root: string; write: (file: string, text: string) => void; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-refresh-'));
  mkdirSync(path.join(root, 'src', 'api'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'daemon'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['src/**/*.ts'] }));
  writeFileSync(path.join(root, 'src', 'hub.ts'), 'export function hub(value: number): number { return value; }\n');
  writeFileSync(path.join(root, 'src', 'leaf.ts'), "export function leaf(): number { return 1; }\n");
  writeFileSync(path.join(root, 'src', 'api', 'index.ts'), "import { hub } from '../hub'; export const api = () => hub(1);\n");
  writeFileSync(path.join(root, 'src', 'daemon', 'manage.ts'), "import { hub } from '../hub'; export const manage = () => hub(2);\n");
  return { root, write: (file, text) => writeFileSync(path.join(root, file), text), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function exercise(change: (write: (file: string, text: string) => void) => { file: string; text: string }, expected: readonly string[] = []): void {
  const { root, write, cleanup } = fixture();
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const store = new Store(path.join(root, 'store'));
  const fullStore = new Store(path.join(root, 'full-store'));
  try {
    projects.load();
    const initial = buildIndex(root, program, projects, store);
    const next = change(write);
    write(next.file, next.text);
    const refreshed = refreshIndex(root, program, projects, store, initial, { fileChanges: { changed: [path.join(root, next.file)] }, validate: true });
    const full = buildIndex(root, program, projects, fullStore);
    assert.ok(graphsEqual({ graph: refreshed.built.graph, relationships: refreshed.built.heritage, dispatchCalls: refreshed.built.receipt.dispatchCalls }, { graph: full.graph, relationships: full.heritage, dispatchCalls: full.receipt.dispatchCalls }));
    for (const file of expected) assert.ok(refreshed.changedFiles.includes(file), `${file} must be replaced`);
  } finally {
    fullStore.close();
    store.close();
    program.close();
    cleanup();
  }
}

test('conservative refresh matches a full rebuild for each spike edit', () => {
  exercise(() => ({ file: 'src/leaf.ts', text: 'export function leaf(): number { return 2; }\n' }));
  exercise(() => ({ file: 'src/leaf.ts', text: 'export function leaf(): number { return 1; }\nexport const added = leaf();\n' }), ['src/leaf.ts']);
  exercise(() => ({ file: 'src/hub.ts', text: 'export function hub(value: number): number { return value; }\nexport const appended = hub(3);\n' }), ['src/hub.ts']);
  exercise(() => ({ file: 'src/hub.ts', text: 'export function hub(value: number, extra = 0): number { return value + extra; }\n' }));
  exercise(() => ({ file: 'src/hub.ts', text: 'export function renamed(value: number): number { return value; }\n' }), ['src/hub.ts', 'src/api/index.ts', 'src/daemon/manage.ts']);
});

test('a tsconfig change reloads project membership and uses a full store rebuild', () => {
  const { root, write, cleanup } = fixture();
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const store = new Store(path.join(root, 'store'));
  try {
    projects.load();
    const initial = buildIndex(root, program, projects, store);
    write('src/hub.ts', 'export function hub(value: number): number { return value + 1; }\n');
    const targeted = refreshIndex(root, program, projects, store, initial, { fileChanges: { changed: [path.join(root, 'src', 'hub.ts')] }, validate: true });
    write('src/added.ts', 'export const added = true;\n');
    rmSync(path.join(root, 'src', 'leaf.ts'));
    write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true, noUncheckedIndexedAccess: true }, include: ['src/**/*.ts'], exclude: ['src/leaf.ts'] }));
    const refreshed = refreshIndex(root, program, projects, store, targeted.built, { fileChanges: { changed: [path.join(root, 'tsconfig.json')], created: [path.join(root, 'src', 'added.ts')], deleted: [path.join(root, 'src', 'leaf.ts')] }, full: true, validate: true });
    assert.equal(refreshed.full, true);
    assert.equal(refreshed.validation, 'matched');
    assert.ok(refreshed.built.graph.files.has('src/added.ts'));
    assert.ok(!refreshed.built.graph.files.has('src/leaf.ts'));
  } finally {
    store.close();
    program.close();
    cleanup();
  }
});

test('a reader waits for the watcher batch that arrived while the previous rebuild ran', async () => {
  const states: string[] = [];
  const snapshot = (name: string): IndexSnapshot => ({ indexedAt: name, state: 'current', built: {} as BuiltIndex });
  const controller = new IndexStateController(snapshot('initial'), (current) => states.push(current.state));
  let release = () => {};
  let signalStarted = () => {};
  const firstRebuild = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
  let batches = 0;
  // Stands in for the watcher's flush: each call refreshes whatever has accumulated since the last one.
  const flush = () => {
    const batch = ++batches;
    return controller.rebuild(async () => {
      if (batch === 1) { signalStarted(); await firstRebuild; }
      // A third event lands while the second rebuild runs; its debounce timer has not fired yet.
      if (batch === 2) controller.markStale(flush);
      return snapshot(`batch-${batch}`);
    });
  };

  controller.markStale(flush);
  const first = flush();
  await firstStarted;
  controller.markStale(flush);
  release();
  await first;
  assert.equal(controller.current().state, 'stale');

  const waited = await controller.wait();
  assert.equal(waited.state, 'current');
  assert.equal(waited.indexedAt, 'batch-3');
  assert.deepEqual(states, ['current', 'stale', 'indexing', 'stale', 'indexing', 'stale', 'indexing', 'current']);
});

test('a file created under a previously empty directory reaches the refresh batch', async () => {
  const { root, cleanup } = fixture();
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const previous = process.env.TSYM_DEBOUNCE_MS;
  process.env.TSYM_DEBOUNCE_MS = '20';
  // The directory exists and holds no source file, so no watched file's dirname names it.
  mkdirSync(path.join(root, 'src', 'empty'), { recursive: true });
  const fresh = path.join(root, 'src', 'empty', 'fresh.ts');
  const batches: WatchBatch[] = [];
  let seen = () => {};
  const arrived = new Promise<void>((resolve) => { seen = resolve; });
  const covered = () => batches.some((batch) => 'created' in batch.fileChanges && batch.fileChanges.created?.includes(fresh));
  try {
    projects.load();
    const watcher = watchIndex(root, projects, async (batch) => { batches.push(batch); if (covered()) seen(); }, (error) => { throw error; }, () => {});
    try {
      writeFileSync(fresh, 'export const fresh = true;\n');
      await Promise.race([arrived, new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`batches: ${JSON.stringify(batches)}`)), 5_000).unref())]);
    } finally { watcher.close(); }
  } finally {
    if (previous === undefined) delete process.env.TSYM_DEBOUNCE_MS; else process.env.TSYM_DEBOUNCE_MS = previous;
    program.close();
    cleanup();
  }
});

test('deleting one of several configs keeps later refreshes working', () => {
  const { root, write, cleanup } = fixture();
  const nested = path.join(root, 'src', 'api', 'tsconfig.json');
  writeFileSync(nested, JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['./**/*.ts'] }));
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const store = new Store(path.join(root, 'store'));
  try {
    projects.load();
    assert.equal(projects.records().length, 2, 'both configs must be discovered before the deletion');
    const initial = buildIndex(root, program, projects, store);
    rmSync(nested);
    const refreshed = refreshIndex(root, program, projects, store, initial, { fileChanges: { deleted: [nested] }, full: true, validate: true });
    assert.equal(refreshed.validation, 'matched');
    assert.equal(projects.records().length, 1, 'the vanished config must be closed, not merely undiscovered');
    // The resident stays usable: an ordinary source edit still refreshes rather than repeating the failed update.
    write('src/hub.ts', 'export function hub(value: number): number { return value; }\nexport const extra = hub(4);\n');
    const after = refreshIndex(root, program, projects, store, refreshed.built, { fileChanges: { changed: [path.join(root, 'src', 'hub.ts')] }, validate: true });
    assert.equal(after.validation, 'matched');
    assert.ok(after.changedFiles.includes('src/hub.ts'));
  } finally {
    store.close();
    program.close();
    cleanup();
  }
});

test('a created file and a rewritten config reach the refresh batch', async () => {
  const { root, write, cleanup } = fixture();
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const previous = process.env.TSYM_DEBOUNCE_MS;
  process.env.TSYM_DEBOUNCE_MS = '20';
  const batches: WatchBatch[] = [];
  let stale = 0;
  let seen = () => {};
  const arrived = new Promise<void>((resolve) => { seen = resolve; });
  const covered = () => batches.some((batch) => 'created' in batch.fileChanges && batch.fileChanges.created?.includes(path.join(root, 'src', 'added.ts')))
    && batches.some((batch) => 'changed' in batch.fileChanges && batch.fileChanges.changed?.includes(path.join(root, 'tsconfig.json')));
  try {
    projects.load();
    const watcher = watchIndex(root, projects, async (batch) => { batches.push(batch); if (covered()) seen(); }, (error) => { throw error; }, () => { stale++; });
    try {
      write('src/added.ts', 'export const added = true;\n');
      write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['src/added.ts'] }));
      await Promise.race([arrived, new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`batches: ${JSON.stringify(batches)}`)), 5_000).unref())]);
    } finally { watcher.close(); }
    assert.ok(stale > 0, 'the watcher must mark the index stale before flushing');
    assert.ok(batches.every((batch) => batch.full), 'a creation or config rewrite requires a full refresh');
  } finally {
    if (previous === undefined) delete process.env.TSYM_DEBOUNCE_MS; else process.env.TSYM_DEBOUNCE_MS = previous;
    program.close();
    cleanup();
  }
});
