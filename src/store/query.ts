import { type LbugValue } from '@ladybugdb/core';
import { Store, type StoreRow } from './store.js';

export type QueryParameters = Record<string, LbugValue>;

/** Executes a parameterized Cypher statement against the resident-owned store. */
export function query(store: Store, cypher: string, parameters: QueryParameters = {}): StoreRow[] {
  return store.executeBounded(cypher, parameters);
}
