import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { renderGraph } from '../src/core/render-graph.js';
import { EmptySymbolList, openWorkspace } from '../src/index.js';
import { ast } from './_fixture.js';

test('trace follows callees breadth-first, keeps the shallowest row, and records dispatch sites', async () => {
  const result = await ast.trace('run', { depth: 2 });
  assert.deepEqual(
    result.items.map((callee) => [callee.depth, callee.qualifiedName]),
    [
      [1, 'greet'],
      [1, 'shout'],
      [1, 'Greeter.say'],
      [1, 'Greeter.make'],
      [2, 'Greeter'],
    ],
  );
  assert.equal(result.receipt.unresolved, 2);
  assert.ok(result.graph?.unresolved.some((edge) => edge.name === 'console.log' && edge.reason === 'external'));
  assert.ok(result.graph);
  assert.ok(result.graph.edges.some((edge) => result.graph!.nodes.find((node) => node.id === edge.from)?.qualifiedName === 'Greeter.say' && result.graph!.nodes.find((node) => node.id === edge.to)?.qualifiedName === 'greet'));
  assert.ok(result.graph.edges.some((edge) => result.graph!.nodes.find((node) => node.id === edge.from)?.qualifiedName === 'shout' && result.graph!.nodes.find((node) => node.id === edge.to)?.qualifiedName === 'greet'));
  assert.equal(result.graph.nodes.find((node) => node.qualifiedName === 'greet')?.depth, 1);
  for (const node of result.graph.nodes) assert.equal((await ast.show(node.id)).items.length, 1);

  const dispatch = await ast.trace('describe');
  assert.equal(dispatch.items.length, 0);
  assert.equal(dispatch.receipt.unresolved, 1);
  assert.deepEqual(dispatch.graph?.unresolved.map((edge) => [edge.name, edge.reason]), [['named.describe', 'dispatch']]);

  const dynamic = await ast.trace('usesAmbient');
  assert.equal(dynamic.receipt.unresolved, 1);
  assert.deepEqual(dynamic.graph?.unresolved.map((edge) => [edge.name, edge.reason]), [['ambient', 'dynamic']]);

  const abstract = await ast.trace('useBase');
  assert.equal(abstract.receipt.unresolved, 1);
  assert.deepEqual(abstract.graph?.unresolved.map((edge) => [edge.name, edge.reason]), [['base.dispatch', 'dispatch']]);

  const multiple = await ast.trace('useBoth');
  assert.deepEqual(multiple.items.map((callee) => callee.name), ['first', 'second']);
  assert.equal(new Set(multiple.graph!.nodes.map((node) => node.id)).size, 3);

  const union = await ast.trace(['run', 'shout']);
  assert.equal(union.graph!.nodes.filter((node) => node.depth === 0).length, 2);
  assert.ok(!union.items.some((item) => item.qualifiedName === 'shout'));
  assert.ok(union.graph!.edges.some((edge) => union.graph!.nodes.find((node) => node.id === edge.from)?.qualifiedName === 'run' && union.graph!.nodes.find((node) => node.id === edge.to)?.qualifiedName === 'shout'));

  const filtered = await ast.trace('run', { exclude: 'src/greet.ts' });
  assert.equal(filtered.receipt.excluded, 5);
  assert.equal(filtered.receipt.unresolved, 1);
  assert.deepEqual(filtered.graph!.nodes.map((node) => node.qualifiedName), ['run']);
  assert.equal(filtered.graph!.edges.length, 0);
  assert.equal(filtered.graph!.unresolved.length, 1);

  const limited = await ast.trace('run', { limit: 1 });
  assert.deepEqual(limited.items.map((item) => item.qualifiedName), ['greet']);
  assert.deepEqual(limited.graph!.nodes.map((node) => [node.qualifiedName, node.connecting]), [
    ['run', undefined],
    ['greet', undefined],
    ['shout', true],
    ['Greeter.say', true],
  ]);
  assertRowsMatchGraph(limited);
  assertConnectedToSeed(limited.graph!);
  assert.equal(limited.receipt.unresolved, limited.graph!.unresolved.length);

  await assert.rejects(() => ast.trace([]), EmptySymbolList);
});

test('--in projects trace rows after traversal and retains connecting nodes', async () => {
  const all = await ast.trace('src/removal.test.ts:0:0');
  const filtered = await ast.trace('src/removal.test.ts:0:0', { in: 'src/app.ts' });
  assert.deepEqual(all.items.map((item) => item.qualifiedName), ['bridgeToUnrelated', 'unrelated']);
  assert.deepEqual(filtered.items.map((item) => item.qualifiedName), ['unrelated']);
  assert.equal(filtered.receipt.excluded, all.items.length - filtered.items.length);
  assert.deepEqual(
    filtered.graph!.nodes.map((node) => [node.qualifiedName, node.connecting]),
    [
      ['src/removal.test.ts', undefined],
      ['bridgeToUnrelated', true],
      ['unrelated', undefined],
    ],
  );
  assertRowsMatchGraph(filtered);
  assertConnectedToSeed(filtered.graph!);
  assert.equal(filtered.receipt.unresolved, filtered.graph!.unresolved.length);

  const graph = renderGraph(filtered.graph!);
  assert.match(graph, /classDef connecting stroke-dasharray: 5 5/);
  assert.match(graph, /class n_[0-9a-f]+ connecting/);
});

test('--exclude retains trace nodes reachable by a longer path', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ast-trace-exclude-'));
  try {
    writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022"}}');
    const sources = {
      'ts.ts': "import { ta } from './ta.js'; import { td } from './td.js'; export function traceSeed() { ta(); td(); }",
      'ta.ts': "import { tb } from './tb.js'; export function ta() { tb(); }",
      'tb.ts': 'export function tb() {}',
      'td.ts': "import { tc } from './tc.js'; export function td() { tc(); }",
      'tc.ts': "import { te } from './te.js'; export function tc() { te(); }",
      'te.ts': "import { tb } from './tb.js'; export function te() { tb(); }",
    };
    for (const [file, source] of Object.entries(sources)) writeFileSync(path.join(root, file), source);
    const result = await openWorkspace(root).trace('traceSeed', { depth: 4, exclude: 'ta.ts' });
    assert.ok(result.items.some((item) => item.name === 'tb'));
    assert.equal(result.receipt.excluded, 1);
    assertConnectedToSeed(result.graph!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderGraph groups declarations by directory and shows unresolved edges', async () => {
  const result = await ast.trace('describe');
  assert.ok(result.graph);
  const graph = renderGraph(result.graph);
  assert.match(graph, /^flowchart TD\n  subgraph /);
  assert.match(graph, /\["src"\]/);
  assert.match(graph, /describe<br\/>src\/app\.ts:15:1/);
  assert.match(graph, /-.-> unresolved_dispatch/);
});

function assertRowsMatchGraph(result: Awaited<ReturnType<typeof ast.trace>>): void {
  const graphRows = result.graph!.nodes.filter((node) => node.depth > 0 && !node.connecting).map((node) => node.id).sort();
  assert.deepEqual(result.items.map((item) => `${item.path}:${item.start.line}:${item.start.col}`).sort(), graphRows);
}

function assertConnectedToSeed(graph: NonNullable<Awaited<ReturnType<typeof ast.trace>>['graph']>): void {
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  const seen = new Set(graph.nodes.filter((node) => node.depth === 0).map((node) => node.id));
  const frontier = [...seen];
  for (let i = 0; i < frontier.length; i++) {
    for (const id of children.get(frontier[i]!) ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        frontier.push(id);
      }
    }
  }
  assert.deepEqual(seen, new Set(graph.nodes.map((node) => node.id)));
}
