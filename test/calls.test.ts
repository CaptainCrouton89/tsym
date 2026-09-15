import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ast } from './_fixture.js';

test('calls lists direct workspace callees and counts calls it cannot follow', async () => {
  const result = await ast.calls('run');
  assert.deepEqual(
    result.items.map((callee) => [callee.kind, callee.qualifiedName, callee.depth]),
    [
      ['function', 'greet', 1],
      ['function', 'shout', 1],
      ['method', 'Greeter.say', 1],
      ['method', 'Greeter.make', 1],
    ],
  );
  assert.equal(result.receipt.unresolved, 1);

  const say = await ast.calls('Greeter.say');
  assert.deepEqual(say.items.map((callee) => callee.qualifiedName), ['greet']);

  const make = await ast.calls('Greeter.make');
  assert.deepEqual(make.items.map((callee) => [callee.kind, callee.qualifiedName]), [['class', 'Greeter']]);

  const filtered = await ast.calls('run', { exclude: 'src/greet.ts' });
  assert.equal(filtered.items.length, 0);
  assert.equal(filtered.receipt.excluded, 4);

  const multiple = await ast.calls(['run', 'shout']);
  assert.equal(multiple.items.filter((callee) => callee.qualifiedName === 'greet')[0]!.callSites, 2);
});

test('calls counts every unresolved call site in a chain, matching trace at depth 1', async () => {
  const chained = await ast.calls('chained');
  assert.equal(chained.items.length, 0);
  assert.equal(chained.receipt.unresolved, 2);
  const traced = await ast.trace('chained', { depth: 1 });
  assert.equal(traced.receipt.unresolved, chained.receipt.unresolved);
});
