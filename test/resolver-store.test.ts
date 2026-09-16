import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DeclarationError, DeclarationResolver } from '../src/core/declarations.js';
import find from '../src/commands/handlers/find.js';
import outline from '../src/commands/handlers/outline.js';
import show from '../src/commands/handlers/show.js';
import { buildIndex } from '../src/index/build.js';
import { SourceReader } from '../src/core/source.js';
import type { SemanticContext } from '../src/server/context.js';
import { Store } from '../src/store/store.js';
import { Ts7Host } from '../src/ts7/api.js';
import { ConfiguredProjects } from '../src/ts7/projects.js';

function fixture(prepare: (root: string) => void = () => {}): { root: string; context: SemanticContext; cleanup: () => void } {
  const temporary = mkdtempSync(path.join(tmpdir(), 'tsym-resolver-store-'));
  const root = path.join(temporary, 'fixture');
  cpSync('test/fixture', root, { recursive: true });
  prepare(root);
  const program = new Ts7Host(root);
  const configured = new ConfiguredProjects(root, program);
  const store = new Store(path.join(temporary, 'store'));
  configured.load();
  buildIndex(root, program, configured, store);
  const source = new SourceReader({
    refreshFile() {},
    sourceFile: (file: string) => configured.sourceFile(file),
    anySourceFile: (file: string) => configured.anySourceFile(file),
  } as never);
  const resolver = new DeclarationResolver(root, source, () => store);
  const projects = {
    bootstrap: async () => [],
    membership: async (file: string) => configured.membership(file),
  };
  const context = { root, program, source, resolver, store, projects } as unknown as SemanticContext;
  return { root, context, cleanup: () => { store.close(); program.close(); rmSync(temporary, { recursive: true, force: true }); } };
}

function invocation(root: string, name: 'outline' | 'find' | 'show', args: string[], flags: Record<string, boolean | number | string | string[]> = {}) {
  return { root, cwd: root, json: false, path: [name], declaration: { name, description: '', argument: { name: name === 'show' ? 'symbol' : name === 'find' ? 'name' : 'path', repeat: '1' as const, description: '' } }, input: { args, flags: { '--depth': 1, ...flags }, explicit: new Set<string>() } } as never;
}

test('the fixture index resolves declarations, usage addresses, and modules without tsserver reads', async () => {
  const { context, cleanup } = fixture((root) => writeFileSync(path.join(root, 'src/alias.ts'), "import { greet as \\u0076eryLongAlias } from './greet.js';\n\\u0076eryLongAlias('x');\n"));
  try {
    assert.equal((await context.resolver.resolve('greet')).address, 'src/greet.ts:2:17');
    assert.equal((await context.resolver.resolve('Greeter.say')).address, 'src/greet.ts:11:3');
    assert.equal((await context.resolver.resolve('hello')).address, 'src/greet.ts:2:17');
    assert.equal((await context.resolver.resolve('run')).address, 'src/app.ts:5:17');
    assert.equal((await context.resolver.resolve('src/app.ts:5:18')).address, 'src/app.ts:5:17');
    assert.equal((await context.resolver.resolve('src/main.ts:3:2')).address, 'src/app.ts:5:17');
    assert.equal((await context.resolver.resolve('src/alias.ts:2:18')).address, 'src/greet.ts:2:17');
    assert.equal((await context.resolver.resolve('src/greet.ts:0:0')).address, 'src/greet.ts:0:0');
    await assert.rejects(context.resolver.resolve('src/greet.ts:999:1'), (error: unknown) => error instanceof DeclarationError && error.code === 'invalid-address');
  } finally { cleanup(); }
});

test('outline, find, and show read the fixture index and source spans', async () => {
  const { context, cleanup } = fixture();
  try {
    const outlined = await outline(context, invocation(context.root, 'outline', ['src/greet.ts']));
    assert.match(outlined.data.text ?? '', /src\/greet\.ts:2:17  function  export  greet  \(3L\)/);
    assert.match(outlined.data.text ?? '', /Greeter  \(11L, 4 members\)/);
    const withImports = await outline(context, invocation(context.root, 'outline', ['src/app.ts'], { '--imports': true }));
    assert.match(withImports.data.text ?? '', /src\/app\.ts:1:1  import  greet, Greeter, shout, Named  src\/greet\.ts/);
    const found = await find(context, invocation(context.root, 'find', ['hello']));
    assert.match(found.data.text ?? '', /src\/app\.ts:19:19  alias  export  hello/);
    const runs = await find(context, invocation(context.root, 'find', ['run']));
    assert.match(runs.data.text ?? '', /src\/app\.ts:5:17  function  export  run/);
    assert.match(runs.data.text ?? '', /Shell\.run/);
    const shown = await show(context, invocation(context.root, 'show', ['src/main.ts:3:1', 'src/greet.ts:0:0']));
    const symbols = shown.data.children ?? [];
    assert.equal(symbols[0]?.attributes.at, 'src/app.ts:5:17');
    assert.match(symbols[0]?.text ?? '', /export function run/);
    assert.match(symbols[1]?.text ?? '', /export class Greeter/);
    const overloaded = await show(context, invocation(context.root, 'show', ['overloaded']));
    assert.equal(overloaded.data.children?.[0]?.attributes.lines, 3);
    assert.equal((overloaded.data.children?.[0]?.text.match(/export function overloaded/g) ?? []).length, 3);
  } finally { cleanup(); }
});

test('show prints a shared declaration line in full', async () => {
  const { context, cleanup } = fixture((root) => writeFileSync(path.join(root, 'src/line-granular.ts'), 'export const sameLineFirst = 1; export const sameLineSecond = 2;\n'));
  try {
    const shown = await show(context, invocation(context.root, 'show', ['sameLineFirst']));
    const symbol = shown.data.children?.[0];
    assert.equal(symbol?.attributes.lines, 1);
    assert.equal(symbol?.text, 'export const sameLineFirst = 1; export const sameLineSecond = 2;');
  } finally { cleanup(); }
});
