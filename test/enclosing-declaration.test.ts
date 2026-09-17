import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

interface Run { status: number | null; stdout: string; stderr: string; }

const cli = path.resolve('dist/cli.js');

function run(root: string, cache: string, ...args: string[]): Run {
  const env = { ...process.env, XDG_CACHE_HOME: cache };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd: root, encoding: 'utf8', env });
}

test('resolves enclosing declarations and reports recovery addresses', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'te-'));
  const root = path.join(temporary, 'fixture');
  const cache = path.join(temporary, 'cache');
  cpSync('test/fixture', root, { recursive: true });
  try {
    const help = run(root, cache, '-h');
    assert.match(help.stdout, /An address on a declared name or reference resolves to that symbol; any other address inside an indexed declaration resolves to the innermost enclosing declaration\. Outside every declaration, the error lists the module address and top-level declaration addresses\./);

    const decorated = run(root, cache, 'show', 'src/enclosing.ts:5:3');
    assert.equal(decorated.status, 0, `${decorated.stderr}\n${decorated.stdout}`);
    assert.match(decorated.stdout, /<symbol at="src\/enclosing\.ts:6:3" name="method" kind="method"/);

    const outer = run(root, cache, 'inspect', 'src/enclosing.ts:12:5', '--only', 'refs');
    assert.equal(outer.status, 0, outer.stderr);
    assert.match(outer.stdout, /<inspect symbol="src\/enclosing\.ts:11:17" name="outer"/);
    const inner = run(root, cache, 'inspect', 'src/enclosing.ts:15:5', '--only', 'refs');
    assert.equal(inner.status, 0, inner.stderr);
    assert.match(inner.stdout, /<inspect symbol="src\/enclosing\.ts:14:12" name="inner"/);

    const reference = run(root, cache, 'show', 'src/enclosing.ts:17:10');
    assert.equal(reference.status, 0, reference.stderr);
    assert.match(reference.stdout, /<symbol at="src\/enclosing\.ts:14:12" name="inner" kind="function"/);
    const sameLine = run(root, cache, 'show', 'src/enclosing.ts:20:22');
    assert.equal(sameLine.status, 0, sameLine.stderr);
    assert.match(sameLine.stdout, /<symbol at="src\/enclosing\.ts:20:14" name="first" kind="const"/);
    const typeReference = run(root, cache, 'show', 'src/computed-precedence.ts:4:12');
    assert.equal(typeReference.status, 0, typeReference.stderr);
    assert.match(typeReference.stdout, /<symbol at="src\/computed-precedence\.ts:2:6" name="Result" kind="type"/);
    const anonymousDefault = run(root, cache, 'show', 'src/default.ts:2:3');
    assert.equal(anonymousDefault.status, 0, anonymousDefault.stderr);
    assert.match(anonymousDefault.stdout, /<symbol at="src\/default\.ts:1:1" name="default" kind="property"/);

    const recovery = run(root, cache, 'show', 'src/enclosing.ts:1:1', 'src/enclosing.ts:3:1');
    assert.equal(recovery.status, 2);
    assert.match(recovery.stdout, /code="unresolvable-symbol"/);
    assert.match(recovery.stdout, /src\/enclosing\.ts:1:1 does not resolve to a declaration/);
    assert.match(recovery.stdout, /src\/enclosing\.ts:3:1 does not resolve to a declaration/);
    assert.match(recovery.stdout, /Module: src\/enclosing\.ts:0:0/);
    assert.match(recovery.stdout, /src\/enclosing\.ts:2:10  function  trace/);
    assert.match(recovery.stdout, /src\/enclosing\.ts:4:14  class  Decorated/);
    assert.match(recovery.stdout, /src\/enclosing\.ts:11:17  function  outer/);
  } finally {
    run(root, cache, 'server', 'stop');
    rmSync(temporary, { recursive: true, force: true });
  }
});
