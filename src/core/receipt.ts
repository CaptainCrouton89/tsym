import type { Engine, Receipt, Result } from './types.js';

export interface ReceiptInput {
  command: string;
  query: string;
  root: string;
  engine: Engine;
  filesScanned: number;
  startedAt: number;
  limit?: number | null;
}

/** Apply `limit`, count matched files, and stamp the receipt. */
export function finish<T extends { path: string }>(input: ReceiptInput, all: T[]): Result<T> {
  const limit = input.limit ?? null;
  const truncated = limit !== null && all.length > limit;
  const items = truncated ? all.slice(0, limit) : all;
  const receipt: Receipt = {
    command: input.command,
    query: input.query,
    root: input.root,
    files_scanned: input.filesScanned,
    files_matched: new Set(items.map((i) => i.path)).size,
    items: items.length,
    truncated,
    limit,
    engine: input.engine,
    elapsed_ms: Math.round(performance.now() - input.startedAt),
  };
  return { items, receipt };
}

export function formatReceipt(r: Receipt): string {
  const cut = r.truncated ? `, truncated at ${r.limit}` : '';
  return `ast: ${r.items} items in ${r.files_matched} files (scanned ${r.files_scanned}, ${r.engine}, ${(r.elapsed_ms / 1000).toFixed(1)}s${cut})`;
}
