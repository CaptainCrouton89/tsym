import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { FIXTURE } from './_fixture.js';

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--cwd', FIXTURE, ...args], { cwd: process.cwd(), encoding: 'utf8' });
}

test('CLI emits calls, accepts multi-seed traversal and repeatable path filters, renders traversal graphs, and rejects --graph elsewhere', () => {
  const calls = run('calls', 'run');
  assert.equal(calls.status, 0);
  assert.match(calls.stdout, /Greeter\.say/);
  const callsJson = run('calls', 'run', '--json');
  assert.equal(callsJson.status, 0);
  assert.equal(JSON.parse(callsJson.stdout).items.length, 4);

  const graph = run('trace', 'run', '--graph');
  assert.equal(graph.status, 0);
  assert.match(graph.stdout, /^flowchart TD/m);
  assert.match(graph.stdout, /Greeter\.say<br\/>src\/greet\.ts:11:3/);

  const union = run('trace', 'run', 'shout', '--json');
  assert.equal(union.status, 0);
  assert.equal(JSON.parse(union.stdout).graph.nodes.filter((node: { depth: number }) => node.depth === 0).length, 2);

  const filtered = run('callers', 'greet', '--exclude', '**/*.test.ts');
  assert.equal(filtered.status, 0);
  assert.doesNotMatch(filtered.stdout, /testCaller/);
  assert.match(filtered.stderr, /1 excluded/);

  const invalidSeed = run('trace', 'run', 'doesNotExist');
  assert.equal(invalidSeed.status, 2);
  assert.match(invalidSeed.stderr, /no symbol matches doesNotExist/);

  const invalid = run('calls', 'run', '--graph');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--graph is only valid with trace or impact/);
});
