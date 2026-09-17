import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildIndex } from '../src/index/build.js';
import { query } from '../src/store/query.js';
import { Store } from '../src/store/store.js';
import { Ts7Host } from '../src/ts7/api.js';
import { ConfiguredProjects } from '../src/ts7/projects.js';

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-index-build-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['src/**/*.ts'] }));
  writeFileSync(path.join(root, 'src', 'lib.ts'), 'export const one = 1;\nexport const two = 2;\n');
  writeFileSync(path.join(root, 'src', 'index.ts'), `
import {
  one,
  two as second,
} from './lib';
interface Contract { work(): void; }
abstract class Parent { abstract base(): void; }
class Worker extends Parent implements Contract {
  work(): void {}
  base(): void {}
}
function invoke(value: Contract): void { value.work(); }
function invokeConcrete(value: Worker): void { value.work(); }
export
  async function spread(): Promise<void> {
}
class ParameterProperties {
  constructor(private prefix: string, readonly label = 'label', plain: number = 0) { void plain; }
  format(): string { return this.prefix + this.label; }
}
`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('build persists heritage edges, dispatch calls, and a null module container', () => {
  const { root, cleanup } = fixture();
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const store = new Store(path.join(root, 'store'));
  try {
    projects.load();
    const built = buildIndex(root, program, projects, store);
    assert.equal(built.receipt.relationships.EXTENDS, 1);
    assert.equal(built.receipt.relationships.IMPLEMENTS, 3);
    assert.equal(built.receipt.dispatchCalls, 1);
    assert.equal(query(store, "MATCH (d:Declaration {kind: 'module'}) RETURN d.container AS container")[0]?.container, null);
    assert.equal(query(store, 'MATCH (:Declaration)-[r:CALLS {dispatch: true}]->() RETURN count(r) AS count')[0]?.count, 1);
    const concreteCall = query(store, "MATCH (caller:Declaration {name: 'invokeConcrete'})-[r:CALLS {dispatch: false}]->(callee:Declaration {name: 'work'}) RETURN caller.key AS caller, callee.key AS callee, r.dispatch AS dispatch")[0];
    assert.deepEqual(concreteCall, { caller: 'src/index.ts#invokeConcrete', callee: 'src/index.ts#Worker.work', dispatch: false });
    assert.equal(query(store, 'MATCH (:Declaration)-[r:IMPORTS]->() RETURN r.names AS names')[0]?.names, 'one, two as second');
    const spread = query(store, "MATCH (d:Declaration {name: 'spread'}) RETURN d.line AS line, d.endLine AS endLine, d.lines AS lines")[0]!;
    assert.deepEqual(spread, { line: 15, endLine: 16, lines: 3 });
    const prefix = query(store, "MATCH (c:Declaration {key: 'src/index.ts#ParameterProperties'})-[:CONTAINS]->(p:Declaration {key: 'src/index.ts#ParameterProperties.prefix'}) RETURN p.kind AS kind, p.container AS container")[0];
    assert.deepEqual(prefix, { kind: 'property', container: 'src/index.ts#ParameterProperties' });
    assert.equal(query(store, "MATCH (:Declaration)-[r:REFERENCES]->(:Declaration {key: 'src/index.ts#ParameterProperties.prefix'}) RETURN count(r) AS count")[0]?.count, 2);
    assert.equal(query(store, "MATCH (:Declaration {key: 'src/index.ts#ParameterProperties.plain'}) RETURN count(*) AS count")[0]?.count, 0);
  } finally {
    store.close();
    program.close();
    cleanup();
  }
});

function bindingFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-index-bindings-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['src/**/*.ts'] }));
  writeFileSync(path.join(root, 'src', 'bindings.ts'), [
    'const api = { useX: () => 1 };',
    'export const { useX } = api;',
    'const useHook = () => [() => 2, { isLoading: true, remote: () => 3 }] as const;',
    'export function View({ ignored }: { ignored: string }) {',
    '  const [createOrg, { isLoading, remote: local }] = useHook();',
    '  return useX() + createOrg() + (isLoading ? local() : 0) + ignored.length;',
    '}',
  ].join('\n'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('build indexes variable-destructuring leaves but not parameter leaves', () => {
  const { root, cleanup } = bindingFixture();
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const store = new Store(path.join(root, 'store'));
  try {
    projects.load();
    buildIndex(root, program, projects, store);
    const declarations = query(store, "MATCH (d:Declaration) WHERE d.key IN ['src/bindings.ts#useX', 'src/bindings.ts#View.createOrg', 'src/bindings.ts#View.isLoading', 'src/bindings.ts#View.local'] RETURN d.key AS key, d.at AS at, d.kind AS kind, d.exported AS exported, d.container AS container ORDER BY d.key");
    assert.deepEqual(declarations, [
      { key: 'src/bindings.ts#View.createOrg', at: 'src/bindings.ts:5:10', kind: 'const', exported: false, container: 'src/bindings.ts#View' },
      { key: 'src/bindings.ts#View.isLoading', at: 'src/bindings.ts:5:23', kind: 'const', exported: false, container: 'src/bindings.ts#View' },
      { key: 'src/bindings.ts#View.local', at: 'src/bindings.ts:5:42', kind: 'const', exported: false, container: 'src/bindings.ts#View' },
      { key: 'src/bindings.ts#useX', at: 'src/bindings.ts:2:16', kind: 'const', exported: true, container: 'src/bindings.ts#<module>' },
    ]);
    assert.equal(query(store, "MATCH (:Declaration {key: 'src/bindings.ts#View.ignored'}) RETURN count(*) AS count")[0]?.count, 0);
    const calls = query(store, "MATCH (:Declaration {key: 'src/bindings.ts#View'})-[:CALLS]->(callee:Declaration) WHERE callee.key IN ['src/bindings.ts#useX', 'src/bindings.ts#View.createOrg', 'src/bindings.ts#View.local'] RETURN callee.key AS key ORDER BY key");
    assert.deepEqual(calls, [{ key: 'src/bindings.ts#View.createOrg' }, { key: 'src/bindings.ts#View.local' }, { key: 'src/bindings.ts#useX' }]);
  } finally {
    store.close();
    program.close();
    cleanup();
  }
});

test('nested locals inside an exported statement are not exported, and anonymous callbacks are functions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-index-nested-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['src/**/*.ts'] }));
  writeFileSync(path.join(root, 'src', 'nested.ts'), [
    'export const leaf = (items: readonly [string, number][]) => {',
    '  for (const [name, count] of items) { void name; void count; }',
    '  return items.filter((item) => Boolean(item[1]));',
    '};',
  ].join('\n'));
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const store = new Store(path.join(root, 'store'));
  try {
    projects.load();
    buildIndex(root, program, projects, store);
    const rows = query(store, "MATCH (d:Declaration) WHERE d.file = 'src/nested.ts' AND d.kind <> 'module' RETURN d.qname AS qname, d.kind AS kind, d.exported AS exported ORDER BY d.qname");
    assert.deepEqual(rows, [
      { qname: 'leaf', kind: 'const', exported: true },
      { qname: 'leaf.<items.filter#arg1:1>', kind: 'function', exported: false },
      { qname: 'leaf.<loop:1>.count', kind: 'const', exported: false },
      { qname: 'leaf.<loop:1>.name', kind: 'const', exported: false },
    ]);
  } finally {
    store.close();
    program.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function coverageFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-index-coverage-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'packages', 'shared', 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, baseUrl: '.', paths: { '@/*': ['src/*'], '@shared/*': ['packages/shared/dist/*'], '@other/*': ['packages/shared/dist/*'] } }, include: ['src/**/*.ts'] }));
  writeFileSync(path.join(root, 'src', 'service.ts'), '// leading comment\nexport class Service { constructor() {} }\n');
  writeFileSync(path.join(root, 'src', 'barrel.ts'), '// leading comment\nexport { Service } from \'./service.js\';\n');
  writeFileSync(path.join(root, 'src', 'controller.ts'), 'import { Service } from \'./service.js\';\nexport class Controller { constructor(private readonly service: Service) {} }\n');
  writeFileSync(path.join(root, 'packages', 'shared', 'dist', 'index.d.ts'), 'export interface Shared { value: string }\nexport declare function helper(): void;\n');
  writeFileSync(path.join(root, 'src', 'imports.ts'), 'import { Service } from \'@/barrel.js\';\nimport type { Service as TypeService } from \'./service.js\';\nimport type { Shared } from \'@shared/index.js\';\nimport type { Shared as OtherShared } from \'@other/index.js\';\nimport { helper } from \'@shared/index.js\';\nimport { readFile } from \'node:fs\';\nexport const value: TypeService = new Service();\nhelper();\nvoid readFile;\nvoid ({} as Shared);\nvoid ({} as OtherShared);\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('build targets an explicit-constructor class and every resolved import module', () => {
  const { root, cleanup } = coverageFixture();
  const program = new Ts7Host(root);
  const projects = new ConfiguredProjects(root, program);
  const store = new Store(path.join(root, 'store'));
  try {
    projects.load();
    buildIndex(root, program, projects, store);
    const classKey = 'src/service.ts#Service';
    const constructorKey = 'src/service.ts#Service.constructor';
    assert.equal(query(store, `MATCH ()-[r:REFERENCES]->(target:Declaration {key: '${classKey}'}) RETURN count(r) AS count`)[0]?.count, 9);
    assert.equal(query(store, `MATCH ()-[r:TYPE_MENTION]->(target:Declaration {key: '${classKey}'}) RETURN count(r) AS count`)[0]?.count, 2);
    assert.equal(query(store, `MATCH ()-[r:REFERENCES|TYPE_MENTION]->(target:Declaration {key: '${constructorKey}'}) RETURN count(r) AS count`)[0]?.count, 0);
    const imports = query(store, "MATCH (:Declaration {key: 'src/imports.ts#<module>'})-[r:IMPORTS]->(target) RETURN target.key AS key ORDER BY r.line").map((row) => row.key);
    assert.deepEqual(imports, ['src/barrel.ts#<module>', 'src/service.ts#<module>', '@shared#<module>', '@other#<module>', '@shared#<module>', 'node:fs#<module>']);
    assert.deepEqual(query(store, "MATCH (:Declaration {key: 'src/controller.ts#<module>'})-[:IMPORTS]->(target) RETURN target.key AS key")[0], { key: 'src/service.ts#<module>' });
    assert.equal(query(store, "MATCH ()-[r:REFERENCES]->(:External {key: '@shared#Shared'}) RETURN count(r) AS count")[0]?.count, 2);
    assert.equal(query(store, "MATCH ()-[r:TYPE_MENTION]->(:External {key: '@shared#Shared'}) RETURN count(r) AS count")[0]?.count, 1);
    assert.equal(query(store, "MATCH ()-[r:CALLS]->(:External {key: '@shared#helper'}) RETURN count(r) AS count")[0]?.count, 1);
    assert.equal(query(store, "MATCH ()-[r:TYPE_MENTION]->(:External {key: '@other#Shared'}) RETURN count(r) AS count")[0]?.count, 1);
  } finally {
    store.close();
    program.close();
    cleanup();
  }
});
