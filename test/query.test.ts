import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commandTree, parseInvocation } from '../src/commands/tree.js';
import queryHandler from '../src/commands/handlers/query.js';
import type { Invocation } from '../src/commands/types.js';
import { renderHelp } from '../src/commands/help.js';
import { loadGraph, type DeclarationRow, type RelationshipRow } from '../src/store/load.js';
import { Store } from '../src/store/store.js';
import { ensureStateDirectory, pathsForRoot } from '../src/server/lifecycle.js';

const q1 = 'MATCH (d:Declaration) WHERE d.exported AND NOT EXISTS { MATCH (s:Declaration)-[:REFERENCES]->(d) WHERE s.file <> d.file } RETURN d.key, d.file, d.line, d.col ORDER BY d.key';
const q2 = "MATCH (d:Declaration) WHERE d.exported AND d.file = $file OPTIONAL MATCH (r:Declaration)-[ref:REFERENCES]->(d) WITH d, count(ref) AS fanIn OPTIONAL MATCH (caller:Declaration)-[call:CALLS]->(d) WITH d, fanIn, caller.key AS caller, count(call) AS sites ORDER BY sites DESC, caller SKIP 0 WITH d, fanIn, collect(CASE WHEN caller IS NOT NULL THEN {caller: caller, sites: sites} ELSE NULL END) AS callers RETURN d.key, fanIn, coalesce(callers[1:3], []) AS topCallers ORDER BY d.key";
const q3 = 'MATCH (impl:Declaration)-[:IMPLEMENTS]->(target:Declaration) WHERE target.key = $key RETURN DISTINCT impl.key, impl.file, impl.line, impl.col ORDER BY impl.key';
const q4 = "MATCH (f:Declaration)-[:TYPE_MENTION]->(t:Declaration) WHERE t.key = $key AND f.kind IN ['function','method'] RETURN DISTINCT f.key, f.file, f.line, f.col ORDER BY f.key";
const q5 = "MATCH (caller:Declaration)-[call:CALLS]->(callee:Declaration) WHERE caller.top = 'src/commands' AND callee.top = 'src/daemon' RETURN caller.key, callee.key, call.line, call.col ORDER BY caller.key, callee.key, call.line UNION MATCH (caller:Declaration)-[call:CALLS]->(ext:External) WHERE caller.top = 'src/api' AND ext.module <> 'lib' RETURN caller.key, ext.key AS callee, call.line, call.col ORDER BY caller.key, callee, call.line";
const q6 = 'UNWIND $commits AS hash MATCH (c:Commit)-[:CHANGED]->(d:Declaration) WHERE c.hash = hash WITH DISTINCT d OPTIONAL MATCH (caller:Declaration)-[:CALLS]->(d) RETURN d.key, coalesce(collect(DISTINCT caller.key), []) AS callers ORDER BY d.key';
const q7 = "MATCH (f:Declaration) WHERE f.kind IN ['function','method'] AND NOT EXISTS { MATCH (:Declaration)-[:CALLS]->(f) } RETURN f.key, f.file, f.line, f.col ORDER BY f.key";
const inbound = 'MATCH (caller:Declaration)-[:CALLS*1..3]->(hub:Declaration) WHERE hub.key = $key RETURN DISTINCT caller.key ORDER BY caller.key';
const outbound = 'MATCH (hub:Declaration)-[:CALLS*1..5]->(callee:Declaration) WHERE hub.key = $key RETURN DISTINCT callee.key ORDER BY callee.key';

interface Fixture { root: string; store: Store; paths: ReturnType<typeof pathsForRoot>; }

let declarationLine = 0;
function declaration(key: string, kind = 'function', exported = false): DeclarationRow {
  const [file, name] = key.split('#') as [string, string];
  const line = ++declarationLine;
  return { key, at: `${file}:${line}:1`, name, qname: name, kind, exported, file, dir: path.posix.dirname(file), top: file.split('/').slice(0, 2).join('/'), line, col: 1, endLine: line, lines: 1, declCount: 1, container: `${file}#<module>` };
}

const declarations = [
  declaration('src/export.ts#unused', 'function', true),
  declaration('src/export.ts#publicApi', 'function', true),
  declaration('src/consumer.ts#consumer'),
  declaration('src/model.ts#Contract', 'interface'),
  declaration('src/impl.ts#Impl', 'class'),
  declaration('src/types.ts#Payload', 'interface'),
  declaration('src/service.ts#usesPayload'),
  declaration('src/commands/command.ts#crosses'),
  declaration('src/daemon/service.ts#danger'),
  declaration('src/api/client.ts#externalCall'),
  declaration('src/caller.ts#first'),
  declaration('src/caller.ts#second'),
  declaration('src/changed.ts#changed'),
  declaration('src/orphan.ts#orphan'),
];

function fixture(timeout?: number): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-query-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'tsym'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'tsym@example.test'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'change'], { cwd: root });
  const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const paths = pathsForRoot(root);
  ensureStateDirectory(paths);
  const store = new Store(paths.store, timeout === undefined ? undefined : { boundedQueryTimeoutMs: timeout });
  const relationships: RelationshipRow[] = [
    { type: 'REFERENCES', from: 'src/consumer.ts#consumer', to: 'src/export.ts#publicApi', target: 'Declaration', line: 2, col: 1, role: 'read' },
    { type: 'CALLS', from: 'src/consumer.ts#consumer', to: 'src/export.ts#publicApi', target: 'Declaration', line: 2, col: 1, dispatch: false },
    { type: 'IMPLEMENTS', from: 'src/impl.ts#Impl', to: 'src/model.ts#Contract', target: 'Declaration' },
    { type: 'TYPE_MENTION', from: 'src/service.ts#usesPayload', to: 'src/types.ts#Payload', target: 'Declaration', line: 7, col: 1, position: 'type' },
    { type: 'CALLS', from: 'src/commands/command.ts#crosses', to: 'src/daemon/service.ts#danger', target: 'Declaration', line: 8, col: 1, dispatch: false },
    { type: 'CALLS', from: 'src/api/client.ts#externalCall', to: 'pkg#call', target: 'External', line: 9, col: 1, dispatch: false },
    { type: 'CALLS', from: 'src/caller.ts#first', to: 'src/caller.ts#second', target: 'Declaration', line: 10, col: 1, dispatch: false },
    { type: 'CALLS', from: 'src/caller.ts#second', to: 'src/daemon/service.ts#danger', target: 'Declaration', line: 11, col: 1, dispatch: false },
    { type: 'CALLS', from: 'src/caller.ts#first', to: 'src/changed.ts#changed', target: 'Declaration', line: 12, col: 1, dispatch: false },
    { type: 'CHANGED', from: hash, to: 'src/changed.ts#changed', target: 'Declaration', added: 1, removed: 0 },
  ];
  loadGraph(store, { declarations, externals: [{ key: 'pkg#call', module: 'pkg', name: 'call' }], commits: [{ hash, ts: '2026-01-01T00:00:00Z', author: 'tsym', subject: 'change' }], relationships });
  return { root, store, paths };
}

function invocation(root: string, cypher: string, flags: string[] = []): Invocation {
  const parsed = parseInvocation(['query', cypher, ...flags], root);
  assert.ok(!('category' in parsed) && !('help' in parsed));
  return { ...parsed, root, cwd: root };
}

async function run(fixture: Fixture, cypher: string, flags: string[] = []) {
  return queryHandler({ root: fixture.root, store: fixture.store, index: { indexedAt: 'fixture-head', state: 'current' } } as never, invocation(fixture.root, cypher, flags));
}

function answer(completion: Awaited<ReturnType<typeof run>>) {
  assert.ok(!('category' in completion));
  return completion;
}

function remove(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

test('runs the seven acceptance questions and both bounded traversals through the fixture graph', async () => {
  const graph = fixture();
  try {
    const runs = [
      await run(graph, q1),
      await run(graph, q2, ['--param', 'file=src/export.ts']),
      await run(graph, q3, ['--param', 'key=src/model.ts#Contract']),
      await run(graph, q4, ['--param', 'key=src/types.ts#Payload']),
      await run(graph, q5),
      await run(graph, q6, ['--since', 'HEAD~1']),
      await run(graph, q7),
      await run(graph, inbound, ['--param', 'key=src/daemon/service.ts#danger']),
      await run(graph, outbound, ['--param', 'key=src/caller.ts#first']),
    ].map(answer);
    assert.deepEqual(runs.map((item) => item.count), [1, 2, 1, 1, 2, 1, 7, 3, 3]);
    assert.match((runs[5]!.data as { text: string }).text, /src\/changed.ts#changed/);
  } finally { remove(graph); }
});

test('binds typed parameters, sorts un-ordered addressed rows, and identifies un-ordered engine rows', async () => {
  const graph = fixture();
  try {
    const parameters = answer(await run(graph, 'RETURN $integer AS integer, $float AS float, $truth AS truth, $text AS text', ['--param', 'integer=7', '--param', 'float=2.5', '--param', 'truth=true', '--param', 'text=007']));
    assert.match((parameters.data as { text: string }).text, /^7  2.5  true  7$/);
    const sorted = answer(await run(graph, 'MATCH (d:Declaration) RETURN d.file AS file, d.line AS line, d.col AS col, d.key AS key'));
    const sortedLines = (sorted.data as { text: string }).text.split('\n');
    assert.deepEqual(sortedLines, [...sortedLines].sort((left, right) => left.localeCompare(right)));
    assert.doesNotMatch(sorted.receipt!, /unordered/);
    const unordered = answer(await run(graph, 'MATCH (d:Declaration) RETURN d.key AS key'));
    assert.match(unordered.receipt!, /unordered/);
    const partialAddress = answer(await run(graph, "RETURN 'f.ts' AS file, 1 AS line"));
    assert.equal((partialAddress.data as { text: string }).text, 'f.ts  1');
    const atAddress = answer(await run(graph, "RETURN 'src/a.ts:1:2' AS at, 'f.ts' AS file, 1 AS line, 2 AS col"));
    assert.equal((atAddress.data as { text: string }).text, 'src/a.ts:1:2  f.ts  1  2');
  } finally { remove(graph); }
});

test('truncates implicit output and writes every explicit output result', async () => {
  const graph = fixture();
  try {
    const implicit = answer(await run(graph, 'UNWIND range(1, 1180) AS n RETURN n'));
    const implicitNode = implicit.data as { children?: Array<{ attributes?: Record<string, string> }>; text: string };
    const implicitPath = implicitNode.children?.[0]?.attributes?.file;
    assert.equal(implicit.count, 1180);
    assert.equal(implicitNode.text.split('\n').length, 100);
    assert.ok(implicitPath && existsSync(implicitPath));
    assert.equal(readFileSync(implicitPath!, 'utf8').trim().split('\n').length, 1180);
    assert.equal(readdirSync(graph.paths.results).length, 1);

    const all = answer(await run(graph, 'UNWIND range(1, 1180) AS n RETURN n', ['--rows', '0']));
    assert.equal((all.data as { text: string }).text.split('\n').length, 1180);
    assert.equal(readdirSync(graph.paths.results).length, 1);

    for (const [name, cypher, flags, expected] of [
      ['below.txt', 'RETURN 1 AS n', [], '1'],
      ['truncated.txt', 'UNWIND range(1, 3) AS n RETURN n', ['--rows', '1'], '1\n2\n3'],
      ['empty.txt', 'MATCH (d:Declaration) WHERE d.key = $key RETURN d.key', ['--param', 'key=missing'], ''],
      ['all.txt', 'UNWIND range(1, 3) AS n RETURN n', ['--rows', '0'], '1\n2\n3'],
    ] as const) {
      const output = path.join(graph.root, name);
      const completion = answer(await run(graph, cypher, [...flags, '--out', output]));
      assert.ok(existsSync(output), `${name} was not written`);
      assert.equal(readFileSync(output, 'utf8').trim(), expected);
      if (name === 'truncated.txt') assert.equal((completion.data as { text: string }).text, '1');
    }
  } finally { remove(graph); }
});

test('rejects malformed queries and maps Ladybug interruption to query-timeout', async () => {
  const graph = fixture(200);
  try {
    const malformed = await run(graph, 'THIS IS NOT CYPHER');
    assert.ok('category' in malformed && malformed.code === 'query-rejected');
    const mutation = await run(graph, "CREATE (d:Declaration {key: 'injected'})");
    assert.ok('category' in mutation && mutation.code === 'query-rejected');
    assert.equal(graph.store.execute("MATCH (d:Declaration) WHERE d.key = 'injected' RETURN d.key").length, 0);
    graph.store.execute('CREATE REL TABLE E(FROM Declaration TO Declaration)');
    graph.store.execute('MATCH (a:Declaration), (b:Declaration) CREATE (a)-[:E]->(b)');
    const timeout = await run(graph, 'MATCH (a:Declaration)-[:E*1..12]->(b:Declaration) RETURN count(*)');
    assert.ok('category' in timeout && timeout.code === 'query-timeout');
  } finally { remove(graph); }
});

test('query help carries the schema, every relationship, examples, and Ladybug dialect differences', () => {
  const query = commandTree.children!.find((child) => child.name === 'query')!;
  const help = renderHelp(query).replace(/\s+/g, ' ');
  for (const text of ['<schema>', 'CONTAINS', 'REFERENCES', 'CALLS', 'IMPLEMENTS', 'EXTENDS', 'TYPE_MENTION', 'IMPORTS', 'EXPORTS', 'CHANGED', 'RENAMED_FROM', '(new:Declaration)-[:RENAMED_FROM {oldKey,basis}]->(c:Commit)', q1, q2, q3, q4, q5, q6, q7, inbound, outbound, 'List comprehensions', 'SKIP or LIMIT', '1-based inclusive', 'collect() over only nulls']) assert.ok(help.includes(text.replace(/\s+/g, ' ')), `help omitted ${text}`);
});
