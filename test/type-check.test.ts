import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function setup() {
  const temp = mkdtempSync(path.join(tmpdir(), 'tsym-type-check-'));
  const root = path.join(temp, 'fixture');
  const cache = mkdtempSync(path.join(tmpdir(), 's-'));
  cpSync('test/fixture', root, { recursive: true });
  writeFileSync(path.join(root, 'src/type-doc.ts'), `/**\n * Returns the input after recording why the caller supplied it.\n * @param value Text to return.\n * @returns The supplied text.\n */\nexport function documentedType(value: string): string {\n  return value;\n}\n`);
  writeFileSync(path.join(root, 'src/check-diagnostics.ts'), 'export const diagnosticValue: string = 42;\n');
  writeFileSync(path.join(root, 'README.md'), '# outside the TypeScript project\n');
  const cli = path.resolve('dist/cli.js');
  const run = (...args: string[]) => runFrom(root, ...args);
  const runFrom = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
  return { temp, cache, root, run, runFrom };
}

async function close(temp: string, cache: string, run: (...args: string[]) => ReturnType<typeof spawnSync>): Promise<void> {
  const status = run('server', 'status');
  const port = /port="([^"]+)"/.exec(status.stdout)?.[1];
  if (port) {
    const removed = endpointRemoved(port);
    assert.equal(run('server', 'stop').status, 0);
    await removed;
  }
  rmSync(temp, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
}

test('type preserves quickinfo, documentation, tags, and a type declaration address', async () => {
  const { temp, cache, run } = setup();
  try {
    const result = run('type', 'documentedType', '--def');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /at="src\/type-doc.ts:6:17" name="documentedType" kind="function" modifiers="export" typeAt="src\/type-doc.ts:6:17"/);
    assert.match(result.stdout, /function documentedType\(value: string\): string/);
    assert.match(result.stdout, /<doc>\nReturns the input after recording why the caller supplied it\./);
    assert.match(result.stdout, /<tag name="param">\nvalue Text to return\./);

    const usage = run('type', 'src/app.ts:1:10');
    assert.equal(usage.status, 0);
    assert.match(usage.stdout, /at="src\/greet.ts:2:17" name="greet"/);
  } finally {
    await close(temp, cache, run);
  }
});

test('check reports file diagnostics, filters before the limit, and clean files exit one', async () => {
  const { temp, cache, root, run, runFrom } = setup();
  try {
    const diagnostic = run('check', 'src/check-diagnostics.ts', '--errors-only');
    assert.equal(diagnostic.status, 0);
    assert.match(diagnostic.stdout, /<diagnostic at="src\/check-diagnostics.ts:1:14" severity="error" code="2322">\nType 'number' is not assignable to type 'string'\./);

    const capped = run('check', 'src/check-diagnostics.ts', '--limit', '0');
    assert.equal(capped.status, 1);
    assert.match(capped.stdout, /errors="0" warnings="0"/);

    const clean = run('check', 'src/greet.ts');
    assert.equal(clean.status, 1);
    assert.match(clean.stdout, /<check scope="src\/greet.ts" errors="0" warnings="0"/);

    const fromSubdirectory = runFrom(path.join(root, 'src'), 'check', 'check-diagnostics.ts', '--errors-only');
    assert.equal(fromSubdirectory.status, 0, 'a relative operand resolves from the client cwd, not the root');
    assert.match(fromSubdirectory.stdout, /<diagnostic at="src\/check-diagnostics.ts:1:14"/);
    const rootRelativeFromSubdirectory = runFrom(path.join(root, 'src'), 'check', 'src/check-diagnostics.ts');
    assert.equal(rootRelativeFromSubdirectory.status, 2);
    assert.match(rootRelativeFromSubdirectory.stderr, /no-such-path/);

    const project = run('check', '--errors-only');
    assert.equal(project.status, 0);
    assert.match(project.stdout, /scope="project" errors="1" warnings="0" suggestions="0"/);
    assert.doesNotMatch(project.stdout, /lib\.dom\.d\.ts/);

    const findAfterProjectCheck = run('find', 'greet');
    assert.equal(findAfterProjectCheck.status, 0, 'a whole-project check keeps the configured project resident');
    assert.match(findAfterProjectCheck.stdout, /src\/greet.ts:2:17  function  export  greet/);

    const inspectAfterProjectCheck = run('inspect', 'shout', '--only', 'calls', '--each', '0');
    assert.equal(inspectAfterProjectCheck.status, 0);
    assert.match(inspectAfterProjectCheck.stdout, /<calls count="1" files="1" shown="1">/);

    const outsideProgram = run('check', 'README.md');
    assert.equal(outsideProgram.status, 2);
    assert.match(outsideProgram.stderr, /README\.md exists but is not part of a TypeScript project/);
    assert.match(outsideProgram.stderr, /expected a file listed by a project tsconfig\.json/);

    const typeFlag = run('type', 'greet', '--errors-only');
    assert.equal(typeFlag.status, 2);
    assert.match(typeFlag.stderr, /--errors-only/);
    const checkFlag = run('check', 'src/greet.ts', '--def');
    assert.equal(checkFlag.status, 2);
    assert.match(checkFlag.stderr, /--def/);
  } finally {
    await close(temp, cache, run);
  }
});

function endpointRemoved(port: string): Promise<void> {
  if (!existsSync(port)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(port), () => {
      if (!existsSync(port)) { watcher.close(); resolve(); }
    });
    setTimeout(() => { watcher.close(); reject(new Error('resident did not remove its endpoint')); }, 5_000).unref();
  });
}
