import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

test('inspect attributes private and module-scope callback callers to their syntax owners', () => {
  const root = mkdtempSync('/tmp/tsym-callers-owner-');
  const cache = mkdtempSync('/tmp/tsym-callers-owner-cache-');
  const run = (...args: string[]) => spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
  try {
    cpSync(path.join(process.cwd(), 'test/fixture'), root, { recursive: true });
    cpSync(path.join(process.cwd(), 'test/callers-owner.fixture.ts'), path.join(root, 'src/callers-owner.fixture.ts'));
    const callers = run('inspect', 'callerOwnerTarget', '--only', 'callers', '--each', '0');
    assert.equal(callers.status, 0, `${callers.stdout}\n${callers.stderr}`);
    assert.match(callers.stdout, /CallerOwner\.#privateCaller  \(1 site\)/);
    assert.match(callers.stdout, /src\/callers-owner\.fixture\.ts:0:0  1  module  callers-owner\.fixture\.ts  \(2 sites\)/);

    const calls = run('inspect', 'src/callers-owner.fixture.ts:6:3', '--only', 'calls', '--each', '0');
    assert.equal(calls.status, 0, `${calls.stdout}\n${calls.stderr}`);
    assert.match(calls.stdout, /callerOwnerTarget/);

    const refs = run('inspect', 'callerOwnerTarget', '--only', 'refs', '--each', '0');
    assert.equal(refs.status, 0, `${refs.stdout}\n${refs.stderr}`);
    assert.match(refs.stdout, /MethodDeclaration  CallerOwner\.#privateCaller  call/);
    assert.match(refs.stdout, /module  callers-owner\.fixture\.ts  call/);

    const fieldCallers = run('inspect', 'fieldOwnerTarget', '--only', 'callers', '--each', '0');
    assert.equal(fieldCallers.status, 0, `${fieldCallers.stdout}\n${fieldCallers.stderr}`);
    assert.match(fieldCallers.stdout, /PropertyDeclaration  FieldOwner\.handler  \(1 site\)/);

    const fieldFunctionCallers = run('inspect', 'fieldFunctionOwnerTarget', '--only', 'callers', '--each', '0');
    assert.equal(fieldFunctionCallers.status, 0, `${fieldFunctionCallers.stdout}\n${fieldFunctionCallers.stderr}`);
    assert.match(fieldFunctionCallers.stdout, /PropertyDeclaration  FieldFunctionOwner\.handler  \(1 site\)/);

    const fieldCalls = run('inspect', 'src/callers-owner.fixture.ts:12:3', '--only', 'calls', '--each', '0');
    assert.equal(fieldCalls.status, 0, `${fieldCalls.stdout}\n${fieldCalls.stderr}`);
    assert.match(fieldCalls.stdout, /fieldOwnerTarget/);

    const fieldRefs = run('inspect', 'fieldOwnerTarget', '--only', 'refs', '--each', '0');
    assert.equal(fieldRefs.status, 0, `${fieldRefs.stdout}\n${fieldRefs.stderr}`);
    assert.match(fieldRefs.stdout, /PropertyDeclaration  FieldOwner\.handler  call/);
  } finally {
    run('server', 'stop');
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
