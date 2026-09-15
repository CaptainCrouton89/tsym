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
});
