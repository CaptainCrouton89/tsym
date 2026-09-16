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
