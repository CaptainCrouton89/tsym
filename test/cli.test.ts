import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function run(...args: string[]) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8' });
}

test('CLI renders declaration-driven help and complete schema failures with one receipt', () => {
  const root = run('-h');
  assert.equal(root.status, 0);
  assert.match(root.stdout, /<command name="tsym"/);
  assert.match(root.stdout, /<server state="stopped"\/>/);
  assert.doesNotMatch(root.stdout, /<input>/);
  assert.equal(root.stderr.trim().split('\n').length, 1);

  const inspect = run('inspect', '-h');
  assert.equal(inspect.status, 0);
  assert.match(inspect.stdout, /<flag name="--each"/);
  assert.match(inspect.stdout, /<flag name="--depth"/);

  const invalid = run('inspect', 'thing', '--only', 'refs', '--depth', '0', '--graph', '--each', '2', '--unknown');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stdout, /--unknown/);
  assert.match(invalid.stdout, /--depth/);
  assert.match(invalid.stdout, /--graph/);
  assert.match(invalid.stdout, /--each/);
  assert.equal(invalid.stderr, 'invocation rejected, 0 ms\n');

  const renamedFlag = run('inspect', 'thing', '--limit', '5');
  assert.equal(renamedFlag.status, 2);
  assert.match(renamedFlag.stdout, /--each N/);
});
