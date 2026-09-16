import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

test('inspect owns calls in function expression contexts and excludes concrete declarations from impl', () => {
  const root = mkdtempSync('/tmp/tsym-inspect-relations-');
  const cache = mkdtempSync('/tmp/tsym-inspect-relations-cache-');
  const run = (...args: string[]) => spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
  try {
    cpSync(path.join(process.cwd(), 'test/fixture'), root, { recursive: true });
    for (const [owner, callee, count] of [
      ['constInitializerOwner', 'constInitializerLeaf', 1],
      ['awaitedInitializerOwner', 'awaitedInitializerLeaf', 1],
      ['argumentOwner', 'argumentLeaf', 2],
      ['conditionOwner', 'conditionLeaf', 1],
      ['templateOwner', 'templateLeaf', 1],
    ]) {
      const result = run('inspect', owner, '--only', 'calls', '--each', '0');
      assert.equal(result.status, 0, `${owner}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`<calls count="${count}" files="1">`));
      assert.match(result.stdout, new RegExp(callee));
    }

    const parameterProperty = run('inspect', 'Greeter.prefix', '--only', 'refs', '--each', '0');
    assert.equal(parameterProperty.status, 0, `${parameterProperty.stdout}\n${parameterProperty.stderr}`);
    assert.match(parameterProperty.stdout, /<refs count="2" files="1">/);
    assert.match(parameterProperty.stdout, /Greeter\.say  read/);

    const concrete = run('inspect', 'constInitializerOwner', '--only', 'impl', '--each', '0');
    assert.equal(concrete.status, 1, `${concrete.stdout}\n${concrete.stderr}`);
    assert.match(concrete.stdout, /<impl count="0"\/>/);

    const contract = run('inspect', 'Sink', '--only', 'impl', '--each', '0');
    assert.equal(contract.status, 0, `${contract.stdout}\n${contract.stderr}`);
    assert.match(contract.stdout, /<impl count="2" files="1">/);
    assert.match(contract.stdout, /FirstSink/);
    assert.match(contract.stdout, /SecondSink/);
  } finally {
    run('server', 'stop');
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
