import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

interface Run { status: number | null; stdout: string; stderr: string; }

test('outline, find, and show use the resident compiler without opening outline files', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'sym-read-'));
  const root = path.join(temporary, 'fixture');
  const cache = path.join(temporary, 'cache');
  cpSync('test/fixture', root, { recursive: true });
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
    const missed = run(root, cache, 'find', 'doesNotExist');
    assert.equal(missed.status, 1);
    assert.match(missed.stdout, /<find name="doesNotExist" count="0"\/>/);

    const shown = run(root, cache, 'show', 'src/main.ts:1:10', 'src/greet.ts:0:0');
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /<symbol at="src\/app\.ts:5:17" name="run" kind="function" lines="5">/);
    assert.match(shown.stdout, /<symbol at="src\/greet\.ts:0:0"/);
    assert.ok(shown.stdout.indexOf('name="run"') < shown.stdout.indexOf('name="greet.ts"'));

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

function run(root: string, cache: string, ...args: string[]): Run {
  const env = { ...process.env, XDG_CACHE_HOME: cache };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env });
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
