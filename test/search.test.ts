import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { FIXTURE, ast } from './_fixture.js';

test('search matches structural patterns with metavariables', async () => {
  const calls = await ast.search('greet($A)');
  assert.deepEqual(
    calls.items.map((m) => `${m.path}:${m.start.line}:${m.start.col}`),
    ['src/app.ts:8:39', 'src/greet.ts:6:48', 'src/greet.ts:13:26', 'src/removal.test.ts:4:10'],
  );
  const news = await ast.search('new Greeter($$$)', { in: 'src/greet.ts' });
  assert.equal(news.items.length, 1);
  assert.equal(news.items[0]!.text, "new Greeter('> ')");
  assert.equal(news.receipt.files_scanned, 4);
  assert.equal(calls.receipt.files_scanned, 4);

  const filtered = await ast.search('greet($A)', { exclude: '**/*.test.ts' });
  assert.equal(filtered.items.length, 3);
  assert.equal(filtered.receipt.excluded, 1);
});

test('search stays local, matches files outside the program, and validates its language', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'symbols-search-'));
  const root = path.join(directory, 'fixture');
  const cache = path.join(directory, 'cache');
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(path.join(root, 'outside.jsx'), "const hidden = greet('outside');\n");
  writeFileSync(path.join(root, 'view.tsx'), 'export const view = <button aria-label="go" />;\n');
  const run = (...args: string[]) => spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
  try {
    const help = run('search', '-h');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /<command name="search"/);

    const limited = run('search', 'greet($A)', '--exclude', '**/*.test.ts', '--limit', '2');
    assert.equal(limited.status, 0);
    assert.match(limited.stdout, /<search pattern="greet\(\$A\)" count="2">/);
    assert.match(limited.stdout, /outside.jsx:1:16  greet\('outside'\)/);
    assert.match(limited.stdout, /src\/app.ts:8:39  greet\('c'\)/);

    const outsideProgram = run('search', 'greet($A)', '--in', 'outside.jsx');
    assert.equal(outsideProgram.status, 0);
    assert.match(outsideProgram.stdout, /outside.jsx:1:16  greet\('outside'\)/);

    const tsx = run('search', '<button aria-label="go" />', '--lang', 'tsx', '--in', 'view.tsx');
    assert.equal(tsx.status, 0);
    assert.match(tsx.stdout, /view.tsx:1:21  &lt;button aria-label="go" \/&gt;/);

    const invalidLanguage = run('search', 'greet($A)', '--lang', 'python');
    assert.equal(invalidLanguage.status, 2);
    assert.match(invalidLanguage.stderr, /expected one of ts, tsx, js, jsx/);

    assert.equal(existsSync(path.join(cache, 'symbols')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
