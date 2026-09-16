import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ingestCommits } from '../src/index/commits.js';
import { describeFile } from '../src/index/descriptor.js';
import { type DeclarationRow, loadGraph, replaceFiles } from '../src/store/load.js';
import { canReuse, hasSourceDrift, hashTsymBuild, metadataFor } from '../src/store/meta.js';
import { query } from '../src/store/query.js';
import { Store } from '../src/store/store.js';
import { ConfiguredProjects } from '../src/ts7/projects.js';
import { Ts7Host } from '../src/ts7/api.js';
import { watchIndex, type WatchBatch } from '../src/index/watch.js';

interface Fixture {
  root: string;
  write(text: string): void;
  commit(subject: string): string;
  load(): Store;
  cleanup(): void;
}

function fixture(initial: string): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-commits-'));
  exec(root, ['init']);
  exec(root, ['config', 'user.name', 'Test']);
  exec(root, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['source.ts'] }));
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const write = (text: string) => writeFileSync(path.join(root, 'source.ts'), text);
  write(initial);
  const commit = (subject: string) => {
    exec(root, ['add', '.']);
    exec(root, ['commit', '-m', subject]);
    return git(root, ['rev-parse', 'HEAD']).trim();
  };
  const load = () => {
    const store = new Store(path.join(root, 'store'));
    const text = readFileSync(path.join(root, 'source.ts'), 'utf8');
    const declarations = describeFile('source.ts', text).filter((declaration) => declaration.scope !== 'excluded').map((declaration) => rowFor(text, declaration));
    loadGraph(store, { declarations, externals: [], relationships: [] });
    return store;
  };
  return { root, write, commit, load, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function rowFor(text: string, declaration: ReturnType<typeof describeFile>[number]): DeclarationRow {
  const lines = text.slice(declaration.start, declaration.end).split('\n').length;
  const beforeName = text.slice(0, declaration.nameStart);
  const line = declaration.name === '<module>' ? 0 : beforeName.split('\n').length;
  const col = declaration.name === '<module>' ? 0 : beforeName.length - beforeName.lastIndexOf('\n');
  const endLine = text.slice(0, declaration.end).split('\n').length;
  const container = declaration.containerPath === '' ? null : `source.ts#${declaration.containerPath}`;
  return {
    key: declaration.key,
    at: declaration.name === '<module>' ? 'source.ts:0:0' : `source.ts:${line}:${col}`,
    name: declaration.name,
    qname: declaration.path,
    kind: declaration.name === '<module>' ? 'module' : 'function',
    exported: declaration.name !== '<module>',
    file: 'source.ts',
    dir: '',
    top: 'source.ts',
    line,
    col,
    endLine,
    lines,
    declCount: 1,
    container,
  };
}

function changed(store: Store): { key: string; added: number; removed: number }[] {
  return query(store, 'MATCH (:Commit)-[r:CHANGED]->(d:Declaration) RETURN d.key AS key, r.added AS added, r.removed AS removed ORDER BY key') as { key: string; added: number; removed: number }[];
}

function git(root: string, args: string[]): string { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }); }
function exec(root: string, args: string[]): void { execFileSync('git', args, { cwd: root, stdio: 'ignore' }); }

test('ingests replacement hunks with new and parent-blob line intersections', () => {
  const subject = fixture('export function replace(): number {\n  return 1;\n}\n');
  try {
    subject.commit('initial');
    subject.write('export function replace(): number {\n  return 2;\n}\n');
    const hash = subject.commit('replacement');
    const store = subject.load();
    try {
      const result = ingestCommits(subject.root, store, [hash]);
      assert.deepEqual(changed(store), [{ key: 'source.ts#replace', added: 1, removed: 1 }]);
      assert.equal(result.commits.length, 1);
      assert.deepEqual(ingestCommits(subject.root, store, [hash]).commits, [], 'a checkpoint is ingested once');
    } finally { store.close(); }
  } finally { subject.cleanup(); }
});

test('maps deletion-only hunks to the containing declaration', () => {
  const subject = fixture('export function deletion(): number {\n  const discarded = 1;\n  return 1;\n}\n');
  try {
    subject.commit('initial');
    subject.write('export function deletion(): number {\n  return 1;\n}\n');
    const hash = subject.commit('delete line');
    const store = subject.load();
    try {
      ingestCommits(subject.root, store, [hash]);
      assert.deepEqual(changed(store), [{ key: 'source.ts#deletion', added: 0, removed: 1 }]);
    } finally { store.close(); }
  } finally { subject.cleanup(); }
});

test('prefers the preceding declaration at an adjacent-declaration deletion boundary', () => {
  const subject = fixture('export function left() {}\n\nexport function right() {}\n');
  try {
    subject.commit('initial');
    subject.write('export function left() {}\nexport function right() {}\n');
    const hash = subject.commit('remove separator');
    const store = subject.load();
    try {
      ingestCommits(subject.root, store, [hash]);
      assert.deepEqual(changed(store), [{ key: 'source.ts#left', added: 0, removed: 1 }]);
    } finally { store.close(); }
  } finally { subject.cleanup(); }
});

test('does not recreate a wholly deleted declaration', () => {
  const subject = fixture('export function gone() {}\n');
  try {
    subject.commit('initial');
    subject.write('');
    const hash = subject.commit('delete declaration');
    const store = subject.load();
    try {
      ingestCommits(subject.root, store, [hash]);
      assert.equal(query(store, "MATCH (:Commit)-[:CHANGED]->(d:Declaration) WHERE d.key = 'source.ts#gone' RETURN d.key").length, 0);
    } finally { store.close(); }
  } finally { subject.cleanup(); }
});

test('uses committed blob spans when the working tree is dirty', () => {
  const subject = fixture('export function dirty(): number {\n  return 1;\n}\n');
  try {
    subject.commit('initial');
    subject.write('export function dirty(): number {\n  return 2;\n}\n');
    const hash = subject.commit('commit source edit');
    subject.write(`${'\n'.repeat(12)}export function dirty(): number {\n  return 2;\n}\n`);
    const store = subject.load();
    try {
      ingestCommits(subject.root, store, [hash]);
      assert.deepEqual(changed(store), [{ key: 'source.ts#dirty', added: 1, removed: 1 }]);
    } finally { store.close(); }
  } finally { subject.cleanup(); }
});

test('graph refreshes retain checkpoint rows for declarations that remain', () => {
  const subject = fixture('export function tracked(): number { return 1; }\n');
  try {
    subject.commit('initial');
    subject.write('export function tracked(): number { return 2; }\n');
    const hash = subject.commit('track source edit');
    const store = subject.load();
    try {
      ingestCommits(subject.root, store, [hash]);
      const text = 'export function tracked(): number { return 2; }\nexport const unrelated = true;\n';
      const graph = { declarations: describeFile('source.ts', text).filter((declaration) => declaration.scope !== 'excluded').map((declaration) => rowFor(text, declaration)), externals: [], relationships: [] };
      replaceFiles(store, ['source.ts'], graph);
      assert.deepEqual(changed(store), [{ key: 'source.ts#tracked', added: 1, removed: 1 }]);
      loadGraph(store, graph);
      assert.deepEqual(changed(store), [{ key: 'source.ts#tracked', added: 1, removed: 1 }]);
    } finally { store.close(); }
  } finally { subject.cleanup(); }
});

test('a HEAD move emits a git invalidation batch for post-refresh checkpoint ingestion', async () => {
  const subject = fixture('export function watched() {}\n');
  const program = new Ts7Host(subject.root);
  const projects = new ConfiguredProjects(subject.root, program);
  const prior = process.env.TSYM_DEBOUNCE_MS;
  process.env.TSYM_DEBOUNCE_MS = '20';
  const batches: WatchBatch[] = [];
  let resolve = () => {};
  const arrived = new Promise<void>((done) => { resolve = done; });
  try {
    subject.commit('initial');
    projects.load();
    const watcher = watchIndex(subject.root, projects, async (batch) => { batches.push(batch); if (batch.git) resolve(); }, (error) => { throw error; }, () => {});
    try {
      subject.write('export function watched() { return; }\n');
      subject.commit('move HEAD');
      await Promise.race([arrived, new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`watch batches: ${JSON.stringify(batches)}`)), 5_000).unref())]);
    } finally { watcher.close(); }
    const batch = batches.find((candidate) => candidate.git);
    assert.deepEqual(batch?.fileChanges, { invalidateAll: true });
    assert.equal(batch?.full, true);
  } finally {
    if (prior === undefined) delete process.env.TSYM_DEBOUNCE_MS; else process.env.TSYM_DEBOUNCE_MS = prior;
    program.close();
    subject.cleanup();
  }
});

test('a linked worktree refreshes for its nested current branch and ignores another branch ref', async () => {
  const subject = fixture('export function watched() {}\n');
  const worktree = mkdtempSync(path.join(tmpdir(), 'tsym-linked-worktree-'));
  rmSync(worktree, { recursive: true, force: true });
  let program: Ts7Host | undefined;
  let watcher: ReturnType<typeof watchIndex> | undefined;
  const prior = process.env.TSYM_DEBOUNCE_MS;
  process.env.TSYM_DEBOUNCE_MS = '20';
  const batches: WatchBatch[] = [];
  let notify = () => {};
  const waitForBatch = () => new Promise<void>((resolve) => { notify = resolve; });
  const awaitBatch = (arrived: Promise<void>) => Promise.race([arrived, new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`watch batches: ${JSON.stringify(batches)}`)), 5_000).unref())]);
  try {
    subject.commit('initial');
    exec(subject.root, ['worktree', 'add', '-b', 'watched', worktree]);
    program = new Ts7Host(worktree);
    const projects = new ConfiguredProjects(worktree, program);
    projects.load();
    watcher = watchIndex(worktree, projects, async (batch) => { batches.push(batch); if (batch.git) notify(); }, (error) => { throw error; }, () => {});
    const watchedAdvance = waitForBatch();
    exec(worktree, ['commit', '--allow-empty', '-m', 'advance watched']);
    await awaitBatch(watchedAdvance);
    assert.equal(batches.length, 1);
    batches.length = 0;
    const switched = waitForBatch();
    exec(worktree, ['checkout', '-b', 'topic/nested']);
    await awaitBatch(switched);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.git, true);
    batches.length = 0;
    const nestedAdvance = waitForBatch();
    exec(worktree, ['commit', '--allow-empty', '-m', 'advance nested']);
    await awaitBatch(nestedAdvance);
    assert.equal(batches.length, 1);
    batches.length = 0;
    exec(subject.root, ['update-ref', 'refs/heads/unrelated', git(worktree, ['rev-parse', 'HEAD']).trim()]);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(batches, []);
  } finally {
    watcher?.close();
    program?.close();
    exec(subject.root, ['worktree', 'remove', '--force', worktree]);
    if (prior === undefined) delete process.env.TSYM_DEBOUNCE_MS; else process.env.TSYM_DEBOUNCE_MS = prior;
    subject.cleanup();
  }
});

test('tsym build hash changes with emitted JavaScript content and paths', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'tsym-dist-'));
  try {
    const first = path.join(dist, 'first.js');
    writeFileSync(first, 'export const value = 1;\n');
    const initial = hashTsymBuild(dist);
    writeFileSync(first, 'export const value = 2;\n');
    const changed = hashTsymBuild(dist);
    assert.notEqual(changed, initial, 'content');
    rmSync(first);
    writeFileSync(path.join(dist, 'second.js'), 'export const value = 2;\n');
    assert.notEqual(hashTsymBuild(dist), changed, 'path');
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

test('source drift reuses the graph shape and requests a refresh', () => {
  const subject = fixture('export function source() {}\n');
  const program = new Ts7Host(subject.root);
  const projects = new ConfiguredProjects(subject.root, program);
  try {
    subject.commit('initial');
    projects.load();
    const before = metadataFor(subject.root, projects, git(subject.root, ['rev-parse', 'HEAD']).trim());
    assert.equal(canReuse({ ...before, tsymBuild: 'different-build' }, before), false, 'tsym build');
    subject.write('export function source() { return; }\n');
    const after = metadataFor(subject.root, projects, before.indexedCommit);
    assert.equal(canReuse(before, after), true);
    assert.equal(hasSourceDrift(before, after), true);
  } finally {
    program.close();
    subject.cleanup();
  }
});

test('config-set, package-content, lockfile, and package-based inherited config changes invalidate persisted reuse', () => {
  const subject = fixture('export function source() {}\n');
  const program = new Ts7Host(subject.root);
  const projects = new ConfiguredProjects(subject.root, program);
  try {
    subject.commit('initial');
    projects.load();
    const before = metadataFor(subject.root, projects, git(subject.root, ['rev-parse', 'HEAD']).trim());
    mkdirSync(path.join(subject.root, 'extra'));
    writeFileSync(path.join(subject.root, 'extra', 'tsconfig.json'), JSON.stringify({ include: ['../source.ts'] }));
    projects.reload();
    assert.equal(canReuse(before, metadataFor(subject.root, projects, before.indexedCommit)), false, 'config set');
    rmSync(path.join(subject.root, 'extra'), { recursive: true });
    projects.reload();
    writeFileSync(path.join(subject.root, 'package.json'), '{"name":"changed"}\n');
    assert.equal(canReuse(before, metadataFor(subject.root, projects, before.indexedCommit)), false, 'package content');
    writeFileSync(path.join(subject.root, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(path.join(subject.root, 'package-lock.json'), '{"lockfileVersion":4}\n');
    assert.equal(canReuse(before, metadataFor(subject.root, projects, before.indexedCommit)), false, 'lockfile');
    writeFileSync(path.join(subject.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    mkdirSync(path.join(subject.root, 'node_modules', 'shared-config'), { recursive: true });
    writeFileSync(path.join(subject.root, 'node_modules', 'shared-config', 'package.json'), '{"name":"shared-config"}\n');
    const inherited = path.join(subject.root, 'node_modules', 'shared-config', 'tsconfig.json');
    writeFileSync(inherited, JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(path.join(subject.root, 'tsconfig.json'), JSON.stringify({ extends: 'shared-config/tsconfig.json', include: ['source.ts'] }));
    projects.reload();
    const packageConfigBefore = metadataFor(subject.root, projects, before.indexedCommit);
    writeFileSync(inherited, JSON.stringify({ compilerOptions: { strict: false } }));
    assert.equal(canReuse(packageConfigBefore, metadataFor(subject.root, projects, before.indexedCommit)), false, 'package inherited config');
  } finally {
    program.close();
    subject.cleanup();
  }
});
