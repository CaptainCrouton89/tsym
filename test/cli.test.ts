import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { FIXTURE } from './_fixture.js';

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--cwd', FIXTURE, ...args], { cwd: process.cwd(), encoding: 'utf8' });
}

test('CLI emits calls, renders traversal graphs, and rejects --graph elsewhere', () => {
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

  const invalid = run('calls', 'run', '--graph');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--graph is only valid with trace or impact/);
});
