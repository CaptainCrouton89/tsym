import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmbiguousSymbol, SymbolNotFound } from '../src/index.js';
import { ast } from './_fixture.js';

test('show returns the declaration with its doc comment; position and name addresses resolve the same', async () => {
  const byName = await ast.show('greet');
  assert.equal(byName.items[0]!.start.line, 1);
  assert.match(byName.items[0]!.source, /^\/\*\* Build a greeting\. \*\/\nexport function greet/);

  const byPos = await ast.show('src/greet.ts:2:17');
  assert.equal(byPos.items[0]!.source, byName.items[0]!.source);

  const byLine = await ast.show('src/greet.ts:3');
  assert.equal(byLine.items[0]!.symbol.name, 'greet');
});

test('show fails on unknown and ambiguous names', async () => {
  await assert.rejects(() => ast.show('nothing'), SymbolNotFound);
  await assert.rejects(() => ast.show('count'), AmbiguousSymbol);
  const picked = await ast.show('count', { path: 'src/app.ts' });
  assert.equal(picked.items[0]!.symbol.qualifiedName, 'Counter.count');
});
