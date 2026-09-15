import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ast } from './_fixture.js';

test('outline lists top-level declarations and members with kinds, names, and export flags', () => {
  const { items, receipt } = ast.outline('src/greet.ts');
  assert.deepEqual(
    items.map((s) => [s.kind, s.qualifiedName, s.exported]),
    [
      ['function', 'greet', true],
      ['function', 'shout', true],
      ['class', 'Greeter', true],
      ['property', 'Greeter.count', false],
      ['method', 'Greeter.constructor', false],
      ['method', 'Greeter.say', false],
      ['method', 'Greeter.make', false],
      ['interface', 'Named', true],
      ['property', 'Named.name', false],
      ['method', 'Named.describe', false],
      ['type', 'Mood', true],
      ['enum', 'Level', true],
      ['property', 'Level.Low', false],
      ['property', 'Level.High', false],
    ],
  );
  assert.deepEqual(items[0]!.namePos, { line: 2, col: 17 });
  assert.equal(items[0]!.start.line, 2);
  assert.equal(items[0]!.end.line, 4);
  assert.equal(receipt.engine, 'ast-grep');
  assert.equal(receipt.files_scanned, 1);
});
