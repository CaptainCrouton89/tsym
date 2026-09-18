import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Connection, Database } from '@ladybugdb/core';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadGraph, readGraph, replaceFile, replaceFiles, type DeclarationRow, type RelationshipRow, type StoreGraph } from '../src/store/load.js';
import { discardIncompatibleStore, formatIdentity, readMetadata, writeMetadata } from '../src/store/meta.js';
import { query } from '../src/store/query.js';
import { STORE_SCHEMA_VERSION } from '../src/store/schema.js';
import { Store } from '../src/store/store.js';
import { ensureStateDirectory, pathsForRoot } from '../src/server/lifecycle.js';
import { refuseSeed } from '../src/store/seed.js';

const storeModule = pathToFileURL(path.resolve('src/store/store.ts')).href;

function declaration(key: string, file = 'src/file.ts'): DeclarationRow {
  return { key, at: `${file}:1:1`, name: key.slice(key.indexOf('#') + 1), qname: key.slice(key.indexOf('#') + 1), kind: 'function', exported: true, file, dir: 'src', top: 'src/file.ts', line: 1, col: 1, endLine: 1, lines: 1, declCount: 1, container: `${file}#<module>` };
}

function temporaryStore(): { root: string; path: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-store-test-'));
  return { root, path: path.join(root, 'store') };
}

function remove(root: string): void { rmSync(root, { recursive: true, force: true }); }

async function killAfter(child: ReturnType<typeof spawn>, text: string): Promise<void> {
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { errors += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not print ${text}: ${output}${errors}`)), 5_000);
    child.stdout.on('data', () => { if (output.includes(text)) { clearTimeout(timeout); resolve(); } });
    child.once('error', reject);
  });
  child.kill('SIGKILL');
  await once(child, 'exit');
}

test('a store from another schema version is discarded whole; the current version is kept', () => {
  const { root, path: storePath } = temporaryStore();
  try {
    const identity = formatIdentity('7');
    assert.equal(discardIncompatibleStore(storePath, identity), false);
    mkdirSync(storePath, { recursive: true });
    assert.equal(discardIncompatibleStore(storePath, identity), true, 'a store without metadata is unreadable');
    mkdirSync(storePath, { recursive: true });
    writeMetadata(storePath, { schemaVersion: STORE_SCHEMA_VERSION, tsVersion: '7', tsymBuild: identity.tsymBuild, root, indexedCommit: '', configSet: [], configHashes: {}, packageHash: '', lockfileHash: '', indexDurationMs: 0, files: {} });
    assert.equal(discardIncompatibleStore(storePath, identity), false);
    assert.ok(readMetadata(storePath));
    const stale = { ...readMetadata(storePath)!, schemaVersion: STORE_SCHEMA_VERSION - 1 };
    rmSync(storePath, { recursive: true, force: true });
    mkdirSync(storePath, { recursive: true });
    writeFileSync(path.join(storePath, 'meta.json'), JSON.stringify(stale));
    assert.equal(discardIncompatibleStore(storePath, identity), true);
    assert.equal(readMetadata(storePath), null);
  } finally { remove(root); }
});

test('store reports a write in flight only while its transaction is active', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  try {
    assert.equal(store.busy, false);
    store.transaction(() => assert.equal(store.busy, true));
    assert.equal(store.busy, false);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('seed handler refusal reasons reject unsafe destinations and unavailable stores', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-seed-refusal-'));
  const cache = path.join(root, 'tsym');
  const destination = path.join(cache, 'destination', 'store.seed');
  try {
    mkdirSync(cache);
    assert.equal(refuseSeed(destination, cache, false, false), 'The resident has not bootstrapped a store.');
    assert.equal(refuseSeed(destination, cache, true, true), 'The resident is writing its store.');
    assert.equal(refuseSeed(path.join(root, 'outside'), cache, true, false), 'The seed destination must be a new directory inside the tsym cache.');
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(cache, 'link'));
    assert.equal(refuseSeed(path.join(cache, 'link', 'store.seed'), cache, true, false), 'The seed destination must be a new directory inside the tsym cache.');
    mkdirSync(destination, { recursive: true });
    assert.equal(refuseSeed(destination, cache, true, false), 'The seed destination must be a new directory inside the tsym cache.');
  } finally { remove(root); }
});

test('schema supports every relationship and pair-qualified COPY', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  try {
    const graph: StoreGraph = {
      declarations: [declaration('src/file.ts#one'), declaration('src/file.ts#two')],
      externals: [{ key: 'node:fs#readFile', module: 'node:fs', name: 'readFile' }],
      commits: [{ hash: 'abc', ts: '2026-01-01T00:00:00Z', author: 'A', subject: 'change' }],
      relationships: [
        { type: 'CONTAINS', from: 'src/file.ts#one', to: 'src/file.ts#two', target: 'Declaration' },
        { type: 'REFERENCES', from: 'src/file.ts#one', to: 'src/file.ts#two', target: 'Declaration', line: 1, col: 1, role: 'read' },
        { type: 'REFERENCES', from: 'src/file.ts#one', to: 'node:fs#readFile', target: 'External', line: 2, col: 1, role: 'read' },
        { type: 'CALLS', from: 'src/file.ts#one', to: 'src/file.ts#two', target: 'Declaration', line: 3, col: 1, dispatch: false },
        { type: 'CALLS', from: 'src/file.ts#one', to: 'node:fs#readFile', target: 'External', line: 4, col: 1, dispatch: false },
        { type: 'IMPLEMENTS', from: 'src/file.ts#one', to: 'src/file.ts#two', target: 'Declaration' },
        { type: 'EXTENDS', from: 'src/file.ts#one', to: 'src/file.ts#two', target: 'Declaration' },
        { type: 'TYPE_MENTION', from: 'src/file.ts#one', to: 'src/file.ts#two', target: 'Declaration', line: 5, col: 1, position: 'type' },
        { type: 'TYPE_MENTION', from: 'src/file.ts#one', to: 'node:fs#readFile', target: 'External', line: 6, col: 1, position: 'type' },
        { type: 'IMPORTS', from: 'src/file.ts#one', to: 'src/file.ts#two', target: 'Declaration', line: 7, names: 'two' },
        { type: 'IMPORTS', from: 'src/file.ts#one', to: 'node:fs#readFile', target: 'External', line: 8, names: 'readFile' },
        { type: 'EXPORTS', from: 'src/file.ts#one', to: 'src/file.ts#two', target: 'Declaration', name: 'two', line: 9, col: 1 },
        { type: 'CHANGED', from: 'abc', to: 'src/file.ts#one', target: 'Declaration', added: 1, removed: 0 },
        { type: 'RENAMED_FROM', from: 'src/file.ts#one', to: 'abc', target: 'Commit', oldKey: 'src/file.ts#old', basis: 'text-identical' },
      ],
    };
    const receipt = loadGraph(store, graph);
    assert.equal(receipt.declarations, 2);
    assert.equal(query(store, 'MATCH (:Declaration)-[r:REFERENCES]->() RETURN count(r) AS count')[0].count, 2);
    assert.equal(query(store, 'MATCH (:Declaration)-[r:REFERENCES]->(:External) RETURN count(r) AS count')[0].count, 1);
    assert.equal(query(store, 'MATCH (:Declaration)-[r:CALLS]->(:External) RETURN count(r) AS count')[0].count, 1);
    assert.equal(query(store, 'MATCH (:Commit)-[r:CHANGED]->(:Declaration) RETURN count(r) AS count')[0].count, 1);
    assert.deepEqual(query(store, 'MATCH (d:Declaration)-[r:RENAMED_FROM]->(c:Commit) RETURN d.key AS key, r.oldKey AS oldKey, r.basis AS basis, c.hash AS hash'), [{ key: 'src/file.ts#one', oldKey: 'src/file.ts#old', basis: 'text-identical', hash: 'abc' }]);
    assert.deepEqual(readGraph(store).relationships.filter((relationship) => relationship.type === 'RENAMED_FROM'), [{ type: 'RENAMED_FROM', from: 'src/file.ts#one', to: 'abc', target: 'Commit', oldKey: 'src/file.ts#old', basis: 'text-identical' }]);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('bounded queries interrupt an unbounded variable-length traversal', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path, { boundedQueryTimeoutMs: 200 });
  try {
    loadGraph(store, { declarations: Array.from({ length: 40 }, (_, index) => declaration(`src/file.ts#d${index}`)), externals: [], relationships: [] });
    store.execute('CREATE REL TABLE E(FROM Declaration TO Declaration)');
    store.execute('MATCH (a:Declaration), (b:Declaration) CREATE (a)-[:E]->(b)');
    const started = performance.now();
    assert.throws(() => store.executeBounded('MATCH (a:Declaration)-[:E*1..12]->(b:Declaration) RETURN count(*)'), /Interrupted\./);
    assert.ok(performance.now() - started < 1_000, 'bounded query did not interrupt promptly');
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('replaces one file and all incident relationships in one transaction', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  try {
    loadGraph(store, {
      declarations: [declaration('src/a.ts#a', 'src/a.ts'), declaration('src/b.ts#b', 'src/b.ts')],
      externals: [{ key: 'pkg#removed', module: 'pkg', name: 'removed' }],
      relationships: [
        { type: 'REFERENCES', from: 'src/b.ts#b', to: 'src/a.ts#a', target: 'Declaration', line: 1, col: 1, role: 'read' },
        { type: 'REFERENCES', from: 'src/a.ts#a', to: 'pkg#removed', target: 'External', line: 2, col: 1, role: 'read' },
      ],
    });
    replaceFile(store, 'src/a.ts', {
      declarations: [declaration('src/a.ts#next', 'src/a.ts')],
      externals: [],
      relationships: [{ type: 'REFERENCES', from: 'src/b.ts#b', to: 'src/a.ts#next', target: 'Declaration', line: 1, col: 1, role: 'read' }],
    });
    assert.equal(query(store, "MATCH (d:Declaration) WHERE d.key = 'src/a.ts#a' RETURN d.key").length, 0);
    assert.deepEqual(query(store, 'MATCH (d:Declaration)-[:REFERENCES]->(t:Declaration) RETURN d.key AS source, t.key AS target'), [{ source: 'src/b.ts#b', target: 'src/a.ts#next' }]);
    assert.equal(query(store, 'MATCH (e:External) RETURN e.key').length, 0);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('replaces circular files after every replacement declaration exists', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  try {
    loadGraph(store, {
      declarations: [declaration('src/a.ts#old', 'src/a.ts'), declaration('src/b.ts#old', 'src/b.ts')],
      externals: [],
      relationships: [
        { type: 'REFERENCES', from: 'src/a.ts#old', to: 'src/b.ts#old', target: 'Declaration', line: 1, col: 1, role: 'read' },
        { type: 'REFERENCES', from: 'src/b.ts#old', to: 'src/a.ts#old', target: 'Declaration', line: 1, col: 1, role: 'read' },
      ],
    });
    replaceFiles(store, ['src/a.ts', 'src/b.ts'], {
      declarations: [declaration('src/a.ts#new', 'src/a.ts'), declaration('src/b.ts#new', 'src/b.ts')],
      externals: [],
      relationships: [
        { type: 'REFERENCES', from: 'src/a.ts#new', to: 'src/b.ts#new', target: 'Declaration', line: 1, col: 1, role: 'read' },
        { type: 'REFERENCES', from: 'src/b.ts#new', to: 'src/a.ts#new', target: 'Declaration', line: 1, col: 1, role: 'read' },
      ],
    });
    assert.deepEqual(query(store, 'MATCH (d:Declaration)-[:REFERENCES]->(t:Declaration) RETURN d.key AS source, t.key AS target ORDER BY source'), [
      { source: 'src/a.ts#new', target: 'src/b.ts#new' },
      { source: 'src/b.ts#new', target: 'src/a.ts#new' },
    ]);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('replaces 219 declarations and 2,219 incoming relationships below 250 ms', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  try {
    const original = Array.from({ length: 219 }, (_, index) => declaration(`src/large.ts#old${index}`, 'src/large.ts'));
    const replacement = Array.from({ length: 219 }, (_, index) => declaration(`src/large.ts#new${index}`, 'src/large.ts'));
    const relationships = (keys: readonly string[]): RelationshipRow[] => Array.from({ length: 2_219 }, (_, index) => ({ type: 'REFERENCES', from: 'src/caller.ts#caller', to: keys[index % keys.length], target: 'Declaration', line: index + 1, col: 1, role: 'read' }));
    loadGraph(store, { declarations: [declaration('src/caller.ts#caller', 'src/caller.ts'), ...original], externals: [], relationships: relationships(original.map(({ key }) => key)) });
    const started = performance.now();
    replaceFile(store, 'src/large.ts', { declarations: replacement, externals: [], relationships: relationships(replacement.map(({ key }) => key)) });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `file replacement took ${elapsed.toFixed(1)} ms`);
    assert.equal(query(store, "MATCH (d:Declaration) WHERE d.file = 'src/large.ts' RETURN count(d) AS count")[0].count, 219);
    assert.equal(query(store, 'MATCH (:Declaration)-[r:REFERENCES]->() RETURN count(r) AS count')[0].count, 2_219);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('one commit can be attached as changed files are replaced', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  const commit = { hash: 'abc', ts: '2026-01-01T00:00:00Z', author: 'A', subject: 'change' };
  try {
    loadGraph(store, { declarations: [declaration('src/a.ts#a', 'src/a.ts'), declaration('src/b.ts#b', 'src/b.ts')], externals: [], relationships: [] });
    replaceFile(store, 'src/a.ts', { declarations: [declaration('src/a.ts#next', 'src/a.ts')], externals: [], commits: [commit], relationships: [{ type: 'CHANGED', from: 'abc', to: 'src/a.ts#next', target: 'Declaration', added: 1, removed: 0 }] });
    replaceFile(store, 'src/b.ts', { declarations: [declaration('src/b.ts#next', 'src/b.ts')], externals: [], commits: [commit], relationships: [{ type: 'CHANGED', from: 'abc', to: 'src/b.ts#next', target: 'Declaration', added: 1, removed: 0 }] });
    assert.equal(query(store, 'MATCH (:Commit)-[r:CHANGED]->(:Declaration) RETURN count(r) AS count')[0].count, 2);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('replaces a file without dropping persisted rename continuity for declarations that remain', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  const commit = { hash: 'abc', ts: '2026-01-01T00:00:00Z', author: 'A', subject: 'rename' };
  try {
    loadGraph(store, {
      declarations: [declaration('src/a.ts#current', 'src/a.ts')],
      externals: [],
      commits: [commit],
      relationships: [{ type: 'RENAMED_FROM', from: 'src/a.ts#current', to: 'abc', target: 'Commit', oldKey: 'src/a.ts#old', basis: 'text-identical' }],
    });
    replaceFile(store, 'src/a.ts', { declarations: [declaration('src/a.ts#current', 'src/a.ts')], externals: [], relationships: [] });
    assert.deepEqual(query(store, 'MATCH (d:Declaration)-[r:RENAMED_FROM]->(c:Commit) RETURN d.key AS key, r.oldKey AS oldKey, r.basis AS basis, c.hash AS hash'), [{ key: 'src/a.ts#current', oldKey: 'src/a.ts#old', basis: 'text-identical', hash: 'abc' }]);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('schema initialization rolls back instead of persisting a partial schema', () => {
  const temp = temporaryStore();
  mkdirSync(temp.path, { recursive: true });
  const database = new Database(path.join(temp.path, 'graph.lbug'));
  const connection = new Connection(database);
  try {
    connection.querySync('BEGIN TRANSACTION');
    connection.querySync('CREATE NODE TABLE Declaration(key STRING, PRIMARY KEY(key))');
    connection.querySync('ROLLBACK');
  } finally {
    connection.closeSync();
    database.closeSync();
  }
  try {
    const store = new Store(temp.path);
    try { assert.equal(query(store, 'MATCH (d:Declaration) RETURN count(d) AS count')[0].count, 0); }
    finally { store.close(); }
  } finally { remove(temp.root); }
});

test('a SIGKILL during a transaction preserves the previous committed graph', async () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  loadGraph(store, { declarations: [declaration('src/file.ts#before')], externals: [], relationships: [] });
  store.close();
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { Store } from ${JSON.stringify(storeModule)}; const store = new Store(${JSON.stringify(temp.path)}); store.execute('BEGIN TRANSACTION'); store.execute('MATCH (d:Declaration) DETACH DELETE d'); console.log('mid-write'); setInterval(() => {}, 1_000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    await killAfter(child, 'mid-write');
    const reopened = new Store(temp.path);
    try { assert.equal(query(reopened, 'MATCH (d:Declaration) RETURN count(d) AS count')[0].count, 1); }
    finally { reopened.close(); }
  } finally { remove(temp.root); }
});

test('refuses a second process before Ladybug opens the store', () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { Store } from ${JSON.stringify(storeModule)}; try { new Store(${JSON.stringify(temp.path)}); } catch (error) { console.log(error.name); process.exit(23); } process.exit(0);`], { encoding: 'utf8' });
    assert.equal(result.status, 23);
    assert.match(result.stdout, /StoreOwnershipError/);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('metadata and state directories preserve every shape input', () => {
  const temp = temporaryStore();
  try {
    const metadata = { schemaVersion: STORE_SCHEMA_VERSION, tsVersion: '7.0.2', tsymBuild: 'build', root: temp.root, indexedCommit: 'abc', configSet: ['tsconfig.json'], configHashes: { 'tsconfig.json': 'config' }, packageHash: 'package', lockfileHash: 'lock', indexDurationMs: 0, files: { 'src/file.ts': 'hash' } };
    writeMetadata(temp.path, metadata);
    assert.deepEqual(readMetadata(temp.path), metadata);
    const paths = pathsForRoot(temp.root);
    ensureStateDirectory(paths);
    assert.ok(paths.store.endsWith('/store'));
    assert.ok(paths.results.endsWith('/results'));
  } finally { remove(temp.root); }
});

test('collects a result larger than V8 accepts as spread arguments', { timeout: 30_000 }, () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  try {
    loadGraph(store, { declarations: Array.from({ length: 130_000 }, (_, index) => declaration(`src/generated.ts#d${index}`, 'src/generated.ts')), externals: [], relationships: [] });
    assert.equal(query(store, 'MATCH (d:Declaration) RETURN d.key AS key').length, 130_000);
  } finally {
    store.close();
    remove(temp.root);
  }
});

test('bulk loads the prototype-load upper-bound graph', { timeout: 30_000 }, () => {
  const temp = temporaryStore();
  const store = new Store(temp.path);
  try {
    const declarations = Array.from({ length: 112_139 }, (_, index) => declaration(`src/generated.ts#d${index}`, 'src/generated.ts'));
    const relationships: RelationshipRow[] = Array.from({ length: 384_957 }, (_, index) => ({ type: 'REFERENCES', from: `src/generated.ts#d${index % 112_139}`, to: `src/generated.ts#d${(index + 1) % 112_139}`, target: 'Declaration', line: index + 1, col: 1, role: 'read' }));
    loadGraph(store, { declarations, externals: [], relationships });
    assert.equal(query(store, 'MATCH (d:Declaration) RETURN count(d) AS count')[0].count, 112_139);
    assert.equal(query(store, 'MATCH (:Declaration)-[r:REFERENCES]->() RETURN count(r) AS count')[0].count, 384_957);
  } finally {
    store.close();
    remove(temp.root);
  }
});
