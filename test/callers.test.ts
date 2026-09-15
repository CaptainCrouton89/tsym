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
    ],
  );

  const make = await ast.callers('Greeter.make');
  assert.deepEqual(make.items.map((c) => c.qualifiedName), ['run']);

  const ctor = await ast.callers('Greeter');
  assert.deepEqual(ctor.items.map((c) => c.qualifiedName), ['Greeter.make']);
});
