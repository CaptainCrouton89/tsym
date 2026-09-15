import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ast } from './_fixture.js';

test('callers lists one row per calling function or method, attributing arrow functions to their const', async () => {
  const { items } = await ast.callers('greet');
  assert.deepEqual(
    items.map((c) => [c.kind, c.qualifiedName, `${c.path}:${c.start.line}`]),
    [
      ['function', 'run', 'src/app.ts:5'],
      ['function', 'shout', 'src/greet.ts:6'],
      ['method', 'Greeter.say', 'src/greet.ts:11'],
      ['function', 'testCaller', 'src/removal.test.ts:3'],
    ],
  );

  const make = await ast.callers('Greeter.make');
  assert.deepEqual(make.items.map((c) => c.qualifiedName), ['run']);

  const ctor = await ast.callers('Greeter');
  assert.deepEqual(ctor.items.map((c) => c.qualifiedName), ['Greeter.make']);

  const filtered = await ast.callers('greet', { exclude: '**/*.test.ts' });
  assert.deepEqual(filtered.items.map((caller) => caller.qualifiedName), ['run', 'shout', 'Greeter.say']);
  assert.equal(filtered.receipt.excluded, 1);

  const bareName = await ast.callers('greet', { exclude: 'removal.test.ts' });
  assert.deepEqual(bareName.items.map((caller) => caller.qualifiedName), ['run', 'shout', 'Greeter.say']);
  assert.equal(bareName.receipt.excluded, 1);

  const multiple = await ast.callers(['greet', 'shout']);
  assert.equal(multiple.items.filter((caller) => caller.qualifiedName === 'run')[0]!.callSites, 2);
});
