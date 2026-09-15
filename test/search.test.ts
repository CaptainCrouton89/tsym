import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ast } from './_fixture.js';

test('search matches structural patterns with metavariables', async () => {
  const calls = await ast.search('greet($A)');
  assert.deepEqual(
    calls.items.map((m) => `${m.path}:${m.start.line}:${m.start.col}`),
    ['src/app.ts:8:39', 'src/greet.ts:6:48', 'src/greet.ts:13:26'],
  );
  const news = await ast.search('new Greeter($$$)', { in: 'src/greet.ts' });
  assert.equal(news.items.length, 1);
  assert.equal(news.items[0]!.text, "new Greeter('> ')");
  assert.equal(news.receipt.files_scanned, 1);
  assert.equal(calls.receipt.files_scanned, 3);
});
