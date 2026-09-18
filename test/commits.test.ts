import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ingestCommits } from '../src/index/commits.js';
import { describeFile } from '../src/index/descriptor.js';
import { type DeclarationRow, loadGraph, replaceFiles } from '../src/store/load.js';
import { hasDrift, hashTsymBuild, metadataFor } from '../src/store/meta.js';
import { query } from '../src/store/query.js';
import { Store } from '../src/store/store.js';
import { copyStore } from '../src/store/seed.js';
import { ConfiguredProjects } from '../src/ts7/projects.js';
import { Ts7Host } from '../src/ts7/api.js';
import { watchIndex, type WatchBatch } from '../src/index/watch.js';

interface Fixture {
  root: string;
  write(text: string, file?: string): void;
  move(from: string, to: string): void;
  commit(subject: string): string;
  load(): Store;
  cleanup(): void;
}

function fixture(initial: string): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-commits-'));
  exec(root, ['init']);
  exec(root, ['config', 'user.name', 'Test']);
  exec(root, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['**/*.ts'] }));
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const write = (text: string, file = 'source.ts') => writeFileSync(path.join(root, file), text);
  const move = (from: string, to: string) => renameSync(path.join(root, from), path.join(root, to));
  write(initial);
  const commit = (subject: string) => {
    exec(root, ['add', '.']);
    exec(root, ['commit', '-m', subject]);
    return git(root, ['rev-parse', 'HEAD']).trim();
  };
  const load = () => {
    const store = new Store(path.join(root, 'store'));
    const declarations = readdirSync(root).filter((file) => file.endsWith('.ts')).sort().flatMap((file) => {
      const text = readFileSync(path.join(root, file), 'utf8');
      return describeFile(file, text).filter((declaration) => declaration.scope !== 'excluded').map((declaration) => rowFor(text, declaration, file));
    });
    loadGraph(store, { declarations, externals: [], relationships: [] });
    return store;
  };
  return { root, write, move, commit, load, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function rowFor(text: string, declaration: ReturnType<typeof describeFile>[number], file = 'source.ts'): DeclarationRow {
  const lines = text.slice(declaration.start, declaration.end).split('\n').length;
  const beforeName = text.slice(0, declaration.nameStart);
  const line = declaration.name === '<module>' ? 0 : beforeName.split('\n').length;
  const col = declaration.name === '<module>' ? 0 : beforeName.length - beforeName.lastIndexOf('\n');
  const endLine = text.slice(0, declaration.end).split('\n').length;
  const container = declaration.containerPath === '' ? null : `${file}#${declaration.containerPath}`;
  return {
    key: declaration.key,
    at: declaration.name === '<module>' ? `${file}:0:0` : `${file}:${line}:${col}`,
    name: declaration.name,
    qname: declaration.path,
    kind: declaration.name === '<module>' ? 'module' : 'function',
    exported: declaration.name !== '<module>',
    file,
    dir: '',
    top: file,
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

function renamed(store: Store): { key: string; oldKey: string; basis: string; hash: string }[] {
  return query(store, 'MATCH (d:Declaration)-[r:RENAMED_FROM]->(c:Commit) RETURN d.key AS key, r.oldKey AS oldKey, r.basis AS basis, c.hash AS hash ORDER BY key') as { key: string; oldKey: string; basis: string; hash: string }[];
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

test('persists text-identical rename candidates without recreating the old declaration', () => {
  const subject = fixture('take(() => leaf());\n');
  try {
    subject.commit('initial');
    subject.write('other(() => leaf());\n');
    const hash = subject.commit('rename call anchor');
    const store = subject.load();
    try {
      assert.deepEqual(ingestCommits(subject.root, store, [hash]).renamed, [{ from: 'source.ts#<other#arg1:1>', oldKey: 'source.ts#<take#arg1:1>', basis: 'text-identical', commit: hash }]);
      assert.deepEqual(renamed(store), [{ key: 'source.ts#<other#arg1:1>', oldKey: 'source.ts#<take#arg1:1>', basis: 'text-identical', hash }]);
      assert.equal(query(store, "MATCH (d:Declaration) WHERE d.key = 'source.ts#<take#arg1:1>' RETURN d.key").length, 0);
      assert.deepEqual(ingestCommits(subject.root, store, [hash]).commits, [], 're-ingestion is idempotent');
      assert.deepEqual(renamed(store), [{ key: 'source.ts#<other#arg1:1>', oldKey: 'source.ts#<take#arg1:1>', basis: 'text-identical', hash }]);
    } finally { store.close(); }
  } finally { subject.cleanup(); }
});

test('persists container-renamed candidates without recreating the old declaration', () => {
  const subject = fixture('export namespace Old { export function same() {} }\n');
  try {
    subject.commit('initial');
    subject.write('export namespace New { export function same() {} }\n');
    const hash = subject.commit('rename container');
    const store = subject.load();
    try {
      ingestCommits(subject.root, store, [hash]);
      assert.deepEqual(renamed(store), [{ key: 'source.ts#New.same', oldKey: 'source.ts#Old.same', basis: 'container-renamed', hash }]);
      assert.equal(query(store, "MATCH (d:Declaration) WHERE d.key = 'source.ts#Old.same' RETURN d.key").length, 0);
    } finally { store.close(); }
  } finally { subject.cleanup(); }
});

test('persists file-moved candidates without recreating the old declaration', () => {
  const subject = fixture('export function moved() {}\n');
  try {
    subject.commit('initial');
    subject.move('source.ts', 'moved.ts');
    const hash = subject.commit('move file');
    const store = subject.load();
    try {
      ingestCommits(subject.root, store, [hash]);
      assert.deepEqual(renamed(store), [{ key: 'moved.ts#moved', oldKey: 'source.ts#moved', basis: 'file-moved', hash }]);
      assert.equal(query(store, "MATCH (d:Declaration) WHERE d.key = 'source.ts#moved' RETURN d.key").length, 0);
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

test('a copied store retains checkpoint history through a file replacement', () => {
  const subject = fixture('export function tracked(): number { return 1; }\nexport function removed(): number { return 1; }\n');
  const destination = path.join(subject.root, 'seeded-store');
  try {
    subject.commit('initial');
    subject.write('export function tracked(): number { return 2; }\nexport function removed(): number { return 1; }\n');
    const hash = subject.commit('track source edit');
    const source = subject.load();
    try {
      ingestCommits(subject.root, source, [hash]);
      source.checkpoint();
      copyStore(source.path, destination);
      const seeded = new Store(destination);
      try {
        const text = 'export function tracked(): number { return 2; }\n';
        const graph = { declarations: describeFile('source.ts', text).filter((declaration) => declaration.scope !== 'excluded').map((declaration) => rowFor(text, declaration)), externals: [], relationships: [] };
        replaceFiles(seeded, ['source.ts'], graph);
        assert.deepEqual(changed(seeded), [{ key: 'source.ts#tracked', added: 1, removed: 1 }]);
        assert.equal(query(seeded, "MATCH (:Commit)-[:CHANGED]->(d:Declaration) WHERE d.key = 'source.ts#removed' RETURN d.key").length, 0);
      } finally { seeded.close(); }
    } finally { source.close(); }
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

test('content-hash drift detects a same-size edit with restored mtime', () => {
  const subject = fixture('export function source() { return 1; }\n');
  const program = new Ts7Host(subject.root);
  const projects = new ConfiguredProjects(subject.root, program);
  try {
    subject.commit('initial');
    projects.load();
    const before = metadataFor(subject.root, projects, git(subject.root, ['rev-parse', 'HEAD']).trim());
    const source = path.join(subject.root, 'source.ts');
    const timestamps = statSync(source);
    subject.write('export function source() { return 2; }\n');
    utimesSync(source, timestamps.atime, timestamps.mtime);
    const after = metadataFor(subject.root, projects, before.indexedCommit);
    assert.equal(after.files['source.ts']?.length, before.files['source.ts']?.length);
    assert.notEqual(after.files['source.ts'], before.files['source.ts']);
    assert.equal(hasDrift(before, after), true);
  } finally {
    program.close();
    subject.cleanup();
  }
});

test('source drift requests a refresh while a commit change is provenance only', () => {
  const subject = fixture('export function source() {}\n');
  const program = new Ts7Host(subject.root);
  const projects = new ConfiguredProjects(subject.root, program);
  try {
    subject.commit('initial');
    projects.load();
    const before = metadataFor(subject.root, projects, git(subject.root, ['rev-parse', 'HEAD']).trim());
    assert.equal(hasDrift(before, { ...before, indexedCommit: 'another-commit' }), false, 'commit');
    assert.equal(hasDrift({ ...before, tsymBuild: 'different-build' }, before), true, 'tsym build');
    subject.write('export function source() { return; }\n');
    const after = metadataFor(subject.root, projects, before.indexedCommit);
    assert.equal(hasDrift(before, after), true);
  } finally {
    program.close();
    subject.cleanup();
  }
});

test('config-set, package-content, lockfile, and package-based inherited config changes request refresh', () => {
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
    assert.equal(hasDrift(before, metadataFor(subject.root, projects, before.indexedCommit)), true, 'config set');
    rmSync(path.join(subject.root, 'extra'), { recursive: true });
    projects.reload();
    writeFileSync(path.join(subject.root, 'package.json'), '{"name":"changed"}\n');
    assert.equal(hasDrift(before, metadataFor(subject.root, projects, before.indexedCommit)), true, 'package content');
    writeFileSync(path.join(subject.root, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(path.join(subject.root, 'package-lock.json'), '{"lockfileVersion":4}\n');
    assert.equal(hasDrift(before, metadataFor(subject.root, projects, before.indexedCommit)), true, 'lockfile');
    writeFileSync(path.join(subject.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    mkdirSync(path.join(subject.root, 'node_modules', 'shared-config'), { recursive: true });
    writeFileSync(path.join(subject.root, 'node_modules', 'shared-config', 'package.json'), '{"name":"shared-config"}\n');
    const inherited = path.join(subject.root, 'node_modules', 'shared-config', 'tsconfig.json');
    writeFileSync(inherited, JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(path.join(subject.root, 'tsconfig.json'), JSON.stringify({ extends: 'shared-config/tsconfig.json', include: ['source.ts'] }));
    projects.reload();
    const packageConfigBefore = metadataFor(subject.root, projects, before.indexedCommit);
    writeFileSync(inherited, JSON.stringify({ compilerOptions: { strict: false } }));
    assert.equal(hasDrift(packageConfigBefore, metadataFor(subject.root, projects, before.indexedCommit)), true, 'package inherited config');
  } finally {
    program.close();
    subject.cleanup();
  }
});
