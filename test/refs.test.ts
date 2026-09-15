import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ast } from './_fixture.js';

test('refs lists every reference site except the declaration, marking writes', async () => {
  const { items, receipt } = await ast.refs('greet');
  assert.deepEqual(
    items.map((r) => `${r.path}:${r.start.line}:${r.start.col}${r.write ? ' w' : ''}`),
    ['src/app.ts:1:10', 'src/app.ts:8:39', 'src/app.ts:19:10', 'src/app.ts:19:19', 'src/greet.ts:6:48', 'src/greet.ts:13:26', 'src/removal.test.ts:1:10', 'src/removal.test.ts:4:10'],
  );
  assert.equal(receipt.engine, 'ts-morph');

  const total = await ast.refs('total');
  assert.deepEqual(total.items.map((r) => [r.start.line, r.write]), [[7, true], [12, false]]);

  const filtered = await ast.refs('greet', { exclude: '**/*.test.ts' });
  assert.equal(filtered.items.length, 6);
  assert.equal(filtered.receipt.excluded, 2);

  const multiple = await ast.refs(['greet', 'shout']);
  assert.equal(multiple.items.length, new Set(multiple.items.map((item) => `${item.path}:${item.start.line}:${item.start.col}`)).size);
});
