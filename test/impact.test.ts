import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openWorkspace } from '../src/index.js';
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
      [1, 'function', 'testCaller'],
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

  const limited = await ast.impact('greet', { limit: 1 });
  assert.deepEqual(limited.items.map((item) => item.qualifiedName), ['run']);
  assert.deepEqual(limited.graph!.nodes.map((node) => node.qualifiedName), ['greet', 'run']);

  const filtered = await ast.impact('greet', { exclude: '**/*.test.ts' });
  assert.equal(filtered.receipt.excluded, 1);
  assert.ok(filtered.graph!.nodes.every((node) => !node.path.endsWith('.test.ts')));
  assertConnectedToSeed(filtered.graph!);

  const pruned = await ast.impact('greet', { exclude: 'src/app.ts' });
  assert.ok(!pruned.graph!.nodes.some((node) => node.qualifiedName === 'src/main.ts'));
  assertConnectedToSeed(pruned.graph!);

  const multiple = await ast.impact(['greet', 'shout']);
  assert.equal(multiple.graph!.nodes.filter((node) => node.depth === 0).length, 2);
  assert.ok(!multiple.items.some((item) => item.qualifiedName === 'shout'));
  assert.equal(new Set(multiple.items.map((item) => `${item.path}:${item.start.line}:${item.start.col}`)).size, multiple.items.length);
});

test('module graph nodes use an address that cannot collide with a declaration', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ast-module-node-'));
  try {
    writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions": {"strict": true}}');
    writeFileSync(path.join(root, 'a.ts'), 'export function target(): void {}\ntarget();\n');
    const project = openWorkspace(root);
    const result = await project.impact('target');
    const module = result.graph!.nodes.find((node) => node.kind === 'module');
    assert.equal(module?.id, 'a.ts:0:0');
    assert.ok(result.graph!.edges.some((edge) => edge.from === module?.id));
    assert.ok(!result.graph!.edges.some((edge) => edge.from === edge.to));
    const shown = await project.show(module!.id);
    assert.equal(shown.items[0]!.symbol.kind, 'module');
    assert.equal(shown.items[0]!.source, 'export function target(): void {}\ntarget();\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertConnectedToSeed(graph: NonNullable<Awaited<ReturnType<typeof ast.impact>>['graph']>): void {
  const neighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to]);
    neighbors.set(edge.to, [...(neighbors.get(edge.to) ?? []), edge.from]);
  }
  const seen = new Set(graph.nodes.filter((node) => node.depth === 0).map((node) => node.id));
  const frontier = [...seen];
  for (let i = 0; i < frontier.length; i++) {
    for (const id of neighbors.get(frontier[i]!) ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        frontier.push(id);
      }
    }
  }
  assert.deepEqual(seen, new Set(graph.nodes.map((node) => node.id)));
}
