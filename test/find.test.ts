import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ast } from './_fixture.js';

test('find by exact name, member name, and glob; --kind and --in narrow; limit truncates', async () => {
  const byName = await ast.find('greet');
  assert.deepEqual(byName.items.map((s) => `${s.path}:${s.namePos.line}`), ['src/greet.ts:2']);

  const member = await ast.find('Greeter.say');
  assert.equal(member.items.length, 1);
  assert.equal(member.items[0]!.kind, 'method');

  const glob = await ast.find('Greeter.*', { kind: 'method' });
  assert.deepEqual(glob.items.map((s) => s.name), ['constructor', 'say', 'make']);

  const scoped = await ast.find('run', { in: 'src/main.ts' });
  assert.equal(scoped.items.length, 0);
  assert.equal(scoped.receipt.files_scanned, 4);
  assert.equal(scoped.receipt.excluded, 1);

  const filtered = await ast.find('*', { exclude: '**/*.test.ts' });
  assert.ok(filtered.items.every((item) => !item.path.endsWith('.test.ts')));
  assert.equal(filtered.receipt.excluded, 1);

  const repeated = await ast.find('greet', { in: ['src/app.ts', 'src/greet.ts'] });
  assert.equal(repeated.items.length, 1);
  assert.equal(repeated.receipt.files_scanned, 4);

  const bareName = await ast.find('greet', { in: 'greet.ts' });
  assert.equal(bareName.items.length, 1);
  assert.equal(bareName.receipt.files_scanned, 4);

  const limited = await ast.find('*', { limit: 2 });
  assert.equal(limited.items.length, 2);
  assert.equal(limited.receipt.truncated, true);
  assert.equal(limited.receipt.limit, 2);
});
