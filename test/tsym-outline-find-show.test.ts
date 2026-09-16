import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

interface Run { status: number | null; stdout: string; stderr: string; }

test('outline, find, and show use the resident compiler without opening outline files', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'sym-read-'));
  const root = path.join(temporary, 'fixture');
  const cache = path.join(temporary, 'cache');
  cpSync('test/fixture', root, { recursive: true });
  writeFileSync(path.join(root, 'src/read-leaf-x&y.ts'), 'export const special = 1;\n');
  writeFileSync(path.join(root, 'src/read-leaf-nested.ts'), 'export namespace Outer { export namespace Inner { export function deep() {} } }\nexport const multi = 1, other = 2;\n');
  try {
    const outline = run(root, cache, 'outline', 'src/greet.ts');
    assert.equal(outline.status, 0, outline.stderr);
    assert.equal(rows(outline.stdout).length, 6);
    assert.doesNotMatch(outline.stdout, /alias/);
    assert.match(outline.stdout, /src\/greet\.ts:2:17  function  export  greet  \(3L\)/);
    assert.match(outline.stdout, /Greeter  \(11L, 5 members\)/);

    const members = run(root, cache, 'outline', 'src/greet.ts', '--members');
    assert.equal(rows(members.stdout).length, 15);
    assert.match(members.stdout, /Greeter\.say/);

    const directory = run(root, cache, 'outline', 'src', '--depth', '1');
    assert.equal(directory.status, 0);
    assert.match(directory.stdout, /src\/greet\.ts  \(1 file, 6 symbols\)/);
    assert.doesNotMatch(directory.stdout, /src\/greet\.ts:2:17/);
    const deeper = run(root, cache, 'outline', 'src', '--depth', '3');
    assert.match(deeper.stdout, /Greeter\.say/);

    const found = run(root, cache, 'find', 'greet');
    assert.equal(found.status, 0);
    assert.match(found.stdout, /src\/greet\.ts:2:17  function  export  greet/);
    const reexport = run(root, cache, 'find', 'hello');
    assert.match(reexport.stdout, /alias  export  hello/);
    const member = run(root, cache, 'find', 'Greeter.say');
    assert.match(member.stdout, /Greeter\.say/);
    const missed = run(root, cache, 'find', 'doesNotExist');
    assert.equal(missed.status, 1);
    assert.match(missed.stdout, /<find name="doesNotExist" count="0"\/>/);

    const shown = run(root, cache, 'show', 'src/main.ts:1:10', 'src/greet.ts:0:0');
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /<symbol at="src\/app\.ts:5:17" name="run" kind="function" lines="5">/);
    assert.match(shown.stdout, /<symbol at="src\/greet\.ts:0:0"/);
    assert.ok(shown.stdout.indexOf('name="run"') < shown.stdout.indexOf('name="greet.ts"'));
    const overload = run(root, cache, 'show', 'overloaded');
    assert.equal(overload.status, 0, overload.stderr);
    assert.equal((overload.stdout.match(/export function overloaded/g) ?? []).length, 3);
    assert.doesNotMatch(overload.stdout, /overloadUsage/);

    const memberSource = run(root, cache, 'show', 'Greeter.say');
    assert.match(memberSource.stdout, /say\(name: string\): string/);
    const invalidAddress = run(root, cache, 'show', 'src/greet.ts:7:14');
    assert.equal(invalidAddress.status, 2);
    assert.match(invalidAddress.stderr, /code="invalid-address"/);
    const escapedOutline = run(root, cache, 'outline', 'src/read-leaf-x&y.ts');
    assert.match(escapedOutline.stdout, /src\/read-leaf-x&amp;y\.ts:1:14/);
    const special = run(root, cache, 'find', 'special');
    assert.match(special.stdout, /src\/read-leaf-x&amp;y\.ts:1:14/);
    const specialSource = run(root, cache, 'show', 'src/read-leaf-x&y.ts:1:14');
    assert.match(specialSource.stdout, /export const special = 1;/);
    const nested = run(root, cache, 'find', 'Outer.Inner.deep');
    assert.match(nested.stdout, /Outer\.Inner\.deep/);
    const nestedSource = run(root, cache, 'show', 'Outer.Inner.deep');
    assert.match(nestedSource.stdout, /export function deep\(\)/);
    const multi = run(root, cache, 'show', 'src/read-leaf-nested.ts:2:14');
    assert.match(multi.stdout, /export const multi = 1, other = 2;/);
    const other = run(root, cache, 'show', 'src/read-leaf-nested.ts:2:25');
    assert.match(other.stdout, /export const multi = 1, other = 2;/);

    const fromSubdirectory = runFrom(path.join(root, 'src'), root, cache, 'outline', 'greet.ts');
    assert.equal(fromSubdirectory.status, 0, 'operands resolve from the client cwd');
    assert.equal(rows(fromSubdirectory.stdout).length, 6);
    assert.match(fromSubdirectory.stdout, /src\/greet\.ts:2:17  function  export  greet/);
    const globFromSubdirectory = runFrom(path.join(root, 'src'), root, cache, 'outline', 'gre*.ts');
    assert.equal(globFromSubdirectory.status, 0, globFromSubdirectory.stderr);
    assert.match(globFromSubdirectory.stdout, /<outline path="gre\*\.ts" depth="1" symbols="6" files="1">/);
    assert.deepEqual(rows(globFromSubdirectory.stdout), rows(fromSubdirectory.stdout), 'a glob operand lists the matched files\' declarations, not a directory container row');

    const outside = run(root, cache, 'outline', 'missing.ts');
    assert.equal(outside.status, 2);
    assert.match(outside.stderr, /<error code="no-such-path">/);
    assert.doesNotMatch(outside.stderr, /at Object\.ThrowNoProject/);

    for (const leaf of ['outline', 'find', 'show']) {
      const help = run(root, cache, leaf, '-h');
      assert.equal(help.status, 0);
      assert.match(help.stdout, new RegExp(`<command name="${leaf}"`));
      assert.match(help.stdout, /<input>/);
      assert.match(help.stdout, /<output>/);
      assert.match(help.stdout, /<effects>/);
    }
  } finally {
    const status = run(root, cache, 'server', 'status');
    const port = /port="([^"]+)"/.exec(status.stdout)?.[1];
    const removed = port ? endpointRemoved(port) : Promise.resolve();
    run(root, cache, 'server', 'stop');
    await removed;
    rmSync(temporary, { recursive: true, force: true });
  }
});

const cli = path.resolve('dist/cli.js');

function run(root: string, cache: string, ...args: string[]): Run { return runFrom(root, root, cache, ...args); }

function runFrom(cwd: string, root: string, cache: string, ...args: string[]): Run {
  const env = { ...process.env, XDG_CACHE_HOME: cache };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd, encoding: 'utf8', env });
}

function rows(stdout: string): string[] { return stdout.split('\n').filter((line) => line.startsWith('src/')); }

function endpointRemoved(port: string): Promise<void> {
  if (!existsSync(port)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(port), () => {
      if (!existsSync(port)) { watcher.close(); resolve(); }
    });
    setTimeout(() => { watcher.close(); reject(new Error('resident did not remove its endpoint')); }, 5_000).unref();
  });
}
