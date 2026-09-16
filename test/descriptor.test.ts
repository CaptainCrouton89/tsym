import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { describeFile } from '../src/index/descriptor.js';
import { indexedDeclarations } from '../src/index/scope.js';

const fixture = (name: string): string => readFileSync(`test/fixture/src/${name}`, 'utf8');
const keys = (file: string, text: string): string[] => indexedDeclarations(file, text).map((declaration) => declaration.key);

test('descriptor parses supplied text without reading the named path and emits UTF-16 declaration and name spans', () => {
  const file = 'committed/blob.ts';
  const text = 'const face = "💩";\nexport function café() { return face; }\n';
  const declaration = indexedDeclarations(file, text).find((item) => item.name === 'café');
  assert.ok(declaration);
  assert.equal(declaration.key, 'committed/blob.ts#café');
  assert.equal(declaration.start, text.indexOf('export'));
  assert.equal(declaration.nameStart, text.indexOf('café'));
  assert.equal(declaration.nameEnd, declaration.nameStart + 'café'.length);
  assert.equal(declaration.end, text.indexOf('\n', declaration.nameEnd));
});

test('descriptor applies rules A through F to literals, blocks, computed names, and anonymous call arguments', () => {
  const file = 'src/rules.ts';
  const text = [
    'const K = "k";',
    'function host(value: string) {',
    '  if (value) { const same = 1; } else { const same = 2; }',
    '  test("first", () => { const callback = 1; ping(); });',
    '  test("second", () => { const callback = 2; pong(); });',
    '  test("duplicate", () => { ping(); });',
    '  test("duplicate", () => { pong(); });',
    '  const table = { [K]: 1, [`${K}2`]: 2 };',
    '  const destructured: { value: string } = { value: "x" };',
    '  type Union = { kind: "a" } | { kind: "b" };',
    '}',
  ].join('\n');
  const output = describeFile(file, text).map((declaration) => declaration.key);
  assert.ok(output.includes('src/rules.ts#host.<then:1>.same'));
  assert.ok(output.includes('src/rules.ts#host.<else:1>.same'));
  assert.ok(output.includes('src/rules.ts#host.<test("first")>.callback'));
  assert.ok(output.includes('src/rules.ts#host.<test("second")>.callback'));
  assert.ok(output.includes('src/rules.ts#host.<test("duplicate")>'));
  assert.ok(output.includes('src/rules.ts#host.<test("duplicate")#2>'));
  assert.ok(output.includes('src/rules.ts#host.table.[computed:K]'));
  assert.ok(output.includes('src/rules.ts#host.table.[computed:`${K}2`]'));
  assert.ok(output.includes('src/rules.ts#host.destructured.<type>.value'));
  assert.ok(output.includes('src/rules.ts#host.Union.<arm:1>.kind'));
  assert.ok(output.includes('src/rules.ts#host.Union.<arm:2>.kind'));
});

test('qualified call anchors stay distinct when their containing statements are reordered', () => {
  const file = 'src/qualified.ts';
  const left = 'this.left.on("ready", () => { const first = 1; });';
  const right = 'this.right.on("ready", () => { const second = 1; });';
  const before = `function host() { ${left} ${right} }`;
  const after = `function host() { ${right} ${left} }`;
  const beforeKeys = describeFile(file, before).map((declaration) => declaration.key);
  const afterKeys = describeFile(file, after).map((declaration) => declaration.key);
  for (const key of ['src/qualified.ts#host.<this.left.on("ready")>.first', 'src/qualified.ts#host.<this.right.on("ready")>.second']) {
    assert.ok(beforeKeys.includes(key), key);
    assert.ok(afterKeys.includes(key), key);
  }
});

test('scope keeps only the approved declaration kinds and anonymous containers with a call site', () => {
  const file = 'src/scope.ts';
  const text = [
    'interface Named { property: string; method(value: string): void; }',
    'type Alias = { member: string };',
    'function outer(parameter: string) {',
    '  const local = 1;',
    '  class LocalClass {}',
    '  function localFunction() {}',
    '  (() => 1);',
    '  (() => ping());',
    '  const object = { property: parameter, shorthand: local };',
    '  const inline: { excluded: string } = { excluded: parameter };',
    '  try { throw new Error(); } catch (caught) { const fromCatch = caught; }',
    '}',
  ].join('\n');
  const output = keys(file, text);
  for (const key of ['src/scope.ts#<module>', 'src/scope.ts#Named', 'src/scope.ts#Named.property', 'src/scope.ts#Named.method', 'src/scope.ts#Alias', 'src/scope.ts#Alias.member', 'src/scope.ts#outer', 'src/scope.ts#outer.local', 'src/scope.ts#outer.LocalClass', 'src/scope.ts#outer.localFunction']) assert.ok(output.includes(key), key);
  assert.ok(output.includes('src/scope.ts#outer.<anon:2>'));
  for (const key of ['src/scope.ts#outer.parameter', 'src/scope.ts#outer.<anon:2>.inline.<type>.excluded']) assert.ok(!output.includes(key), key);
});

test('scope excludes locals in class static blocks and unnamed blocks under named containers', () => {
  const file = 'src/static.ts';
  const text = 'class C { static { const staticLocal = 1; function staticFunction() {} } method() { const methodLocal = 1; } } namespace N { if (true) { const nested = 1; } export const member = 1; }';
  const output = keys(file, text);
  for (const key of ['src/static.ts#C.<block:1>.staticLocal', 'src/static.ts#C.<block:1>.staticFunction', 'src/static.ts#N.<then:1>.nested']) assert.ok(!output.includes(key), key);
  for (const key of ['src/static.ts#C.method', 'src/static.ts#C.method.methodLocal', 'src/static.ts#N.member']) assert.ok(output.includes(key), key);
});

test('fixture covers enums, namespaces, anonymous default classes, declaration merging, and cross-file fragments', () => {
  const a = keys('test/fixture/src/descriptor-a.ts', fixture('descriptor-a.ts'));
  const b = keys('test/fixture/src/descriptor-b.ts', fixture('descriptor-b.ts'));
  for (const key of ['#Mode', '#Mode.Fast', '#Shell.NAME', '#Shell.run', '#default', '#default.method', '#over', '#Grow', '#Shell2']) assert.ok(a.some((item) => item.endsWith(key)), key);
  assert.equal(a.filter((item) => item.endsWith('#over')).length, 3);
  assert.equal(a.filter((item) => item.endsWith('#Grow')).length, 2);
  assert.ok(a.some((item) => item.endsWith('#global.GlobalThing.fromA')));
  assert.ok(b.some((item) => item.endsWith('#global.GlobalThing.fromB')));
  assert.ok(b.some((item) => item.endsWith('#Shell.extra')));
});

test('position-only edits preserve keys', () => {
  const file = 'src/stable.ts';
  const original = 'export const first = 1;\nexport const second = () => test("ok", () => ping());\n';
  const blankLines = `\n\n\n\n\n\n\n\n\n\n${original}`;
  const reformatted = 'export const first=1; export const second=()=>test("ok",()=>ping());\n';
  const swapped = 'export const second = () => test("ok", () => ping());\nexport const first = 1;\n';
  const expected = [...new Set(keys(file, original))].sort();
  for (const text of [blankLines, reformatted, swapped]) assert.deepEqual([...new Set(keys(file, text))].sort(), expected);
});

test('same-file declaration merging retains one key per overload, accessor pair, and merged interface', () => {
  const file = 'src/merge.ts';
  const text = [
    'function over(value: string): void;',
    'function over(value: number): void;',
    'function over(value: unknown): void {}',
    'class Access { get value() { return 1; } set value(next: number) {} }',
    'interface Both { left: string }',
    'interface Both { right: string }',
  ].join('\n');
  const all = describeFile(file, text);
  assert.equal(all.filter((item) => item.key === 'src/merge.ts#over').length, 3);
  assert.equal(all.filter((item) => item.key === 'src/merge.ts#Access.value').length, 2);
  assert.equal(all.filter((item) => item.key === 'src/merge.ts#Both').length, 2);
});
