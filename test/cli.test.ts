import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Help reads the resident's published state from the cache, so an isolated cache keeps a developer's live resident out of the assertion.
function run(...args: string[]) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: mkdtempSync(path.join(tmpdir(), 'tsym-cli-help-')) } });
}

function runAt(root: string, cache: string, ...args: string[]) {
  return spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
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

test('search reports an ast-grep pattern that does not parse as one node', () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-search-'));
  try {
    const result = runAt(path.resolve('test/fixture'), cache, 'search', 'foo<Bar>; baz', '--in', 'src/greet.ts');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /<error code="invalid-pattern">/);
    assert.match(result.stdout, /Multiple AST nodes are detected/);
    assert.match(result.stdout, /foo<Bar>; baz/);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('CLI help reads the published index state without a resident socket', () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'tsym-help-'));
  const root = path.resolve('test/fixture');
  const state = path.join(cache, 'tsym', createHash('sha256').update(root).digest('hex').slice(0, 16));
  try {
    mkdirSync(path.join(state, 'store'), { recursive: true });
    writeFileSync(path.join(state, 'pid'), JSON.stringify({ root, pid: 1, bootedAt: '2026-01-01T00:00:00.000Z', port: path.join(state, 'port'), log: path.join(state, 'log'), idleDeadline: '2026-01-01T00:15:00.000Z', state: 'ready', index: 'stale', declarations: 42 }));
    writeFileSync(path.join(state, 'store', 'meta.json'), JSON.stringify({ indexedCommit: 'abc123', indexDurationMs: 9 }));
    const help = runAt(root, cache, 'find', '-h');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /<server root="[^"]+" state="ready" indexedCommit="abc123" indexDuration="9ms" index="stale" declarations="42"\/>/);
    const queryHelp = runAt(root, cache, 'query', '-h');
    assert.equal(queryHelp.status, 0, queryHelp.stderr);
    assert.match(queryHelp.stdout, /<server root="[^"]+" state="ready" indexedCommit="abc123" indexDuration="9ms" index="stale" declarations="42"\/>/);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
