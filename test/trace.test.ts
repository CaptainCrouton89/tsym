import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderGraph } from '../src/core/render-graph.js';
import { EmptySymbolList } from '../src/index.js';
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
  assert.deepEqual(limited.graph!.nodes.map((node) => node.qualifiedName), ['run', 'greet']);
  assert.equal(limited.receipt.unresolved, limited.graph!.unresolved.length);

  await assert.rejects(() => ast.trace([]), EmptySymbolList);
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
