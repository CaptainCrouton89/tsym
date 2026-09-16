import assert from 'node:assert/strict';
import { test } from 'node:test';
import { references } from '../src/relations/store-relations.js';
import type { DeclarationRecord } from '../src/core/declarations.js';
import type { SemanticContext } from '../src/server/context.js';

const seed: DeclarationRecord = {
  address: 'src/target.ts:1:17',
  location: { path: 'src/target.ts', line: 1, col: 17 },
  file: '/workspace/src/target.ts',
  kind: 'function',
  name: 'target',
  qualifiedName: 'target',
  nameSpan: { start: 0, end: 6 },
  span: { start: 0, end: 6 },
};

test('references uses declaration data returned by the store without resolving every owner', async () => {
  const store = {
    executeBounded(statement: string) {
      if (statement.includes('MATCH (declaration:Declaration)')) return [{ key: 'src/target.ts#target' }];
      return [{ file: 'src/caller.ts', kind: 'function', qname: 'caller', line: 4, col: 3, role: 'call' }];
    },
  };
  const context = {
    root: '/workspace',
    store,
    resolver: { resolve: async () => { throw new Error('relation rows must not resolve source declarations'); } },
  } as unknown as SemanticContext;

  assert.deepEqual(await references(context, seed, { in: [], exclude: [] }), [{ path: 'src/caller.ts', line: 4, col: 3, kind: 'function', qualifiedName: 'caller', role: 'call' }]);
});
