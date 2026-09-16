import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { applyRenamePlan, type RenameFileOperations, type RenamePlan } from '../src/commands/rename-apply.js';

const scratch = path.join(process.env.HOME!, '.crouter', 'canvas', 'scratch');

function copiedFixture(): { root: string; cache: string; close: () => void } {
  const root = mkdtempSync(path.join(scratch, 'symbols-rename-fixture-'));
  const cache = mkdtempSync(path.join(scratch, 'symbols-rename-cache-'));
  cpSync('test/fixture', root, { recursive: true });
  renameSync(path.join(root, 'src/rename-shorthand.rename.ts.txt'), path.join(root, 'src/rename-shorthand.ts'));
  renameSync(path.join(root, 'src/rename-string-literal.rename.ts.txt'), path.join(root, 'src/rename-string-literal.ts'));
  return {
    root,
    cache,
    close: () => {
      run(root, cache, 'server', 'stop');
      rmSync(root, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    },
  };
}

function run(root: string, cache: string, ...args: string[]) {
  return spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
}

test('rename previews shorthand and string-literal edits without writing, then applies exactly the preview files', () => {
  const fixture = copiedFixture();
  try {
    const shorthand = path.join(fixture.root, 'src/rename-shorthand.ts');
    const stringLiteral = path.join(fixture.root, 'src/rename-string-literal.ts');
    const before = new Map([[shorthand, readFileSync(shorthand)], [stringLiteral, readFileSync(stringLiteral)]]);

    const preview = run(fixture.root, fixture.cache, 'rename', 'renameShorthandValue', 'renamedShorthandValue');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /applied="false"/);
    assert.match(preview.stdout, /renameShorthandValue → renamedShorthandValue/);
    assert.deepEqual(readFileSync(shorthand), before.get(shorthand));
    assert.deepEqual(readFileSync(stringLiteral), before.get(stringLiteral));

    const stringPreview = run(fixture.root, fixture.cache, 'rename', 'src/rename-string-literal.ts:2:4', 'renamedStringValue');
    assert.equal(stringPreview.status, 0, stringPreview.stderr);
    assert.match(stringPreview.stdout, /6:53  renameStringValue → renamedStringValue/);
    assert.deepEqual(readFileSync(stringLiteral), before.get(stringLiteral));

    const applied = run(fixture.root, fixture.cache, 'rename', 'renameShorthandValue', 'renamedShorthandValue', '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /applied="true"/);
    assert.match(readFileSync(shorthand, 'utf8'), /renamedShorthandValue/);
    assert.deepEqual(readFileSync(stringLiteral), before.get(stringLiteral));
  } finally {
    fixture.close();
  }
});

test('rename apply removes staged files after preparation and commit failures and restores committed files', async () => {
  const fixture = copiedFixture();
  try {
    const plan = testPlan(fixture.root, ['src/rename-shorthand.ts', 'src/rename-string-literal.ts']);
    const originals = new Map(plan.files.map((file) => [file.path, readFileSync(path.join(fixture.root, file.path))]));
    const base: RenameFileOperations = { readFile, writeFile, rename, rm, stat, chmod };

    const preparation = await applyRenamePlan(plan, { ...base, writeFile: async () => { throw new Error('injected preparation failure'); } });
    assert.equal('category' in preparation && preparation.code, 'rename-write-failed');
    assertSources(fixture.root, originals);
    assertNoStagedFiles(fixture.root);

    let commits = 0;
    const commit = await applyRenamePlan(plan, {
      ...base,
      rename: async (from, to) => {
        if (String(from).endsWith('.new')) {
          commits++;
          if (commits === 2) throw new Error('injected commit failure');
        }
        await rename(from, to);
      },
    });
    assert.equal('category' in commit && commit.code, 'rename-write-failed');
    assertSources(fixture.root, originals);
    assertNoStagedFiles(fixture.root);
  } finally {
    fixture.close();
  }
});

function testPlan(root: string, paths: readonly string[]): RenamePlan {
  return {
    root,
    symbol: 'fixture',
    from: 'rename',
    to: 'renamed',
    files: paths.map((file) => {
      const source = readFileSync(path.join(root, file));
      const startByte = source.indexOf(Buffer.from('rename'));
      assert.notEqual(startByte, -1);
      return { path: file, snapshot: source.toString('base64'), edits: [{ startByte, endByte: startByte + 'rename'.length, line: 1, col: 1, oldText: 'rename', replacement: 'renamed' }] };
    }),
  };
}

function assertSources(root: string, originals: ReadonlyMap<string, Buffer>): void {
  for (const [file, original] of originals) assert.deepEqual(readFileSync(path.join(root, file)), original, file);
}

function assertNoStagedFiles(root: string): void {
  for (const file of ['src/rename-shorthand.ts', 'src/rename-string-literal.ts']) {
    const directory = path.dirname(path.join(root, file));
    assert.equal(readdirSync(directory).some((entry) => entry.includes('.symbols-rename-')), false);
  }
}
