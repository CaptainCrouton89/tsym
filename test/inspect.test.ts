import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { graphAfterExclusion, projectGraph } from '../src/relations/graph.js';
import { renderGraph } from '../src/relations/mermaid.js';
import type { Graph } from '../src/relations/types.js';

function node(id: string, depth: number, pathName = 'src/flow.ts') { return { id, path: pathName, start: { line: depth + 1, col: 1 }, end: { line: depth + 1, col: 1 }, kind: 'function', name: id, qualifiedName: id, depth }; }

const graph: Graph = {
  nodes: [node('seed', 0, 'src/root.ts'), node('left', 1, 'src/left.ts'), node('right', 1, 'src/right.ts'), node('target', 2, 'src/target.ts')],
  edges: [
    { from: 'seed', to: 'left', kind: 'call', siteIds: ['one'], callSites: 1 },
    { from: 'seed', to: 'right', kind: 'call', siteIds: ['two'], callSites: 1 },
    { from: 'left', to: 'target', kind: 'call', siteIds: ['three'], callSites: 1 },
    { from: 'right', to: 'target', kind: 'call', siteIds: ['four'], callSites: 1 },
  ],
  unresolved: [],
};

test('graph exclusion preserves a longer path and projection retains connecting declarations', () => {
  const excluded = graphAfterExclusion(graph, ['src/left.ts'], 'calls');
  assert.deepEqual(excluded.nodes.map((item) => item.id), ['seed', 'right', 'target']);
  const projected = projectGraph(graph, 'calls', ['src/target.ts']);
  assert.deepEqual(projected.rows.map((item) => item.id), ['target']);
  assert.equal(projected.graph.nodes.find((item) => item.id === 'right')?.connecting, true);
  assert.match(renderGraph(projected.graph), /^flowchart TD/);
});

test('inspect follows both interface implementations and reports one dispatch site', () => {
  const root = mkdtempSync('/tmp/symbols-inspect-');
  const cache = mkdtempSync('/tmp/symbols-inspect-cache-');
  try {
    cpSync(path.join(process.cwd(), 'test/fixture'), root, { recursive: true });
    const run = (...args: string[]) => spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
    const calls = run('inspect', 'deliver', '--only', 'calls', '--depth', '2', '--each', '0');
    assert.equal(calls.status, 0, `${calls.stdout}\n${calls.stderr}`);
    assert.match(calls.stdout, /FirstSink\.send[\s\S]*impl/);
    assert.match(calls.stdout, /SecondSink\.send[\s\S]*impl/);
    assert.match(calls.stdout, /firstLeaf/);
    assert.match(calls.stdout, /secondLeaf/);
    assert.match(calls.stderr, /1 dispatch/);
    assert.doesNotMatch(calls.stderr, /unresolved/);

    const missing = run('inspect', 'missing', '--only', 'calls', '--each', '0');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /1 unresolved, 1 dispatch/);

    const graphResult = run('inspect', 'deliver', '--only', 'calls', '--depth', '2', '--graph');
    assert.equal(graphResult.status, 0);
    assert.match(graphResult.stdout, /-\.\-&gt;\|impl\|/);
    const addresses = [...graphResult.stdout.matchAll(/src\/inspect-dispatch\.ts:\d+:\d+/g)].map((match) => match[0]!);
    assert.equal(addresses.length, 5);

    for (const [entry, implementation, leaf] of [['deliverAbstract', 'ConcreteSink.send', 'abstractLeaf'], ['deliverAmbient', 'ConcreteAmbientSink.send', 'ambientLeaf']]) {
      const result = run('inspect', entry!, '--only', 'calls', '--depth', '2', '--each', '0');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /<calls count="2"/);
      assert.ok(result.stdout.includes(implementation!));
      assert.ok(result.stdout.includes(leaf!));
      assert.match(result.stderr, /1 dispatch/);
      assert.doesNotMatch(result.stderr, /unresolved/);
    }
    const dynamic = run('inspect', 'invokeDynamic', '--only', 'calls', '--graph');
    assert.equal(dynamic.status, 1);
    assert.match(dynamic.stdout, /unresolved_dynamic/);
    assert.match(dynamic.stderr, /1 unresolved/);
    const external = run('inspect', 'chained', '--only', 'calls', '--graph');
    assert.equal(external.status, 1);
    assert.match(external.stdout, /unresolved_external/);
    const nested = run('inspect', 'nestedArrowTarget', '--only', 'callers', '--each', '0');
    assert.equal(nested.status, 0);
    assert.match(nested.stdout, /VariableDeclaration  nestedArrow/);
    const module = run('inspect', 'run', '--only', 'callers', '--each', '0');
    assert.match(module.stdout, /src\/main\.ts:0:0/);

    const incoming = run('inspect', 'src/inspect-dispatch.ts:2:42', '--only', 'callers', '--each', '0');
    assert.equal(incoming.status, 0);
    assert.match(incoming.stdout, /deliver[\s\S]*impl/);
  } finally {
    const stop = spawnSync(process.execPath, ['dist/cli.js', '--root', root, 'server', 'stop'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
    void stop;
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
