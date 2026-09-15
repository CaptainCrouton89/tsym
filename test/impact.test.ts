import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ast } from './_fixture.js';

test('impact follows callers transitively to the requested depth and lists re-exports', async () => {
  const deep = await ast.impact('greet', { depth: 2 });
  assert.deepEqual(
    deep.items.map((c) => [c.depth, c.kind, c.qualifiedName]),
    [
      [1, 'function', 'run'],
      [1, 'export', 'hello'],
      [1, 'function', 'shout'],
      [1, 'method', 'Greeter.say'],
      [2, 'module', 'src/main.ts'],
    ],
  );
  assert.ok(deep.graph);
  assert.ok(deep.graph.edges.some((edge) => deep.graph!.nodes.find((node) => node.id === edge.from)?.qualifiedName === 'Greeter.say' && edge.to === deep.graph!.nodes.find((node) => node.qualifiedName === 'greet')?.id));
  assert.equal(deep.graph.nodes.find((node) => node.qualifiedName === 'run')?.depth, 1);
  for (const node of deep.graph.nodes) {
    assert.equal((await ast.show(node.id)).items.length, 1);
    await ast.trace(node.id, { depth: 1 });
  }
  const shallow = await ast.impact('greet', { depth: 1 });
  assert.ok(shallow.items.every((c) => c.depth === 1));
});
