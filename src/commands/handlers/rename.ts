import path from 'node:path';
import { matchesPathFilters } from '../../core/receipt.js';
import { RenamePreflightError, renameFromOccurrences } from '../../ts7/checker.js';
import { query } from '../../store/query.js';
import type { StoreRow } from '../../store/store.js';
import type { RenameEdit, RenameFilePlan, RenamePlan } from '../rename-apply.js';
import type { Answer, InvocationError } from '../types.js';
import type { SemanticHandler } from '../handlers.js';

const handler: SemanticHandler = async (context, invocation) => {
  const [input, newName] = invocation.input.args;
  if (!input || !newName) return invalid('rename needs a symbol and a replacement identifier.', input ?? 'none', 'exactly two values: <symbol> <newName>');

  await context.projects.bootstrap();
  const declaration = await context.resolver.resolve(input);
  try {
    if (!context.store) throw new Error('The TypeScript index is not available yet.');
    const edits = renameFromOccurrences(context.program, context.root, context.projects.configured(), declaration, occurrences(context.store, declaration.location.path, declaration.location.line, declaration.location.col), newName);
    const plan = buildPlan(context.root, declaration.address, declaration.name, newName, edits, context.source.read.bind(context.source));
    const visible = plan.files.filter((file) => matchesPathFilters(file.path, { in: strings(invocation.input.flags['--in']), exclude: strings(invocation.input.flags['--exclude']) }));
    const sites = visible.reduce((total, file) => total + file.edits.length, 0);
    const answer: Answer & { renamePlan: RenamePlan } = {
      data: { element: 'rename', attributes: { symbol: declaration.address, from: declaration.name, to: newName, sites, files: visible.length, applied: false }, children: visible.map(renderFile) },
      count: sites,
      receipt: `${sites} rename site${sites === 1 ? '' : 's'} across ${visible.length} file${visible.length === 1 ? '' : 's'}, 0 ms`,
      renamePlan: plan,
    };
    return answer;
  } catch (error) {
    if (error instanceof RenamePreflightError) return refusal(error, input);
    return { category: 'tool', code: 'typescript-error', message: `TypeScript could not prepare this rename: ${message(error)}.`, received: input, expected: 'checker-resolved occurrence locations', next: 'Read server status and retry after repairing the workspace.' };
  }
};

function occurrences(store: import('../../store/store.js').Store, file: string, line: number, col: number): Array<{ file: string; line: number; col: number }> {
  return query(store, 'MATCH (owner:Declaration)-[r:REFERENCES]->(d:Declaration) WHERE d.file = $file AND d.line = $line AND d.col = $col RETURN owner.file AS file, r.line AS line, r.col AS col', { file, line, col }).map((row: StoreRow) => ({ file: String(row.file), line: Number(row.line), col: Number(row.col) }));
}

function buildPlan(root: string, symbol: string, from: string, to: string, locations: readonly ({ file: string; line: number; col: number } & RenameEdit)[], read: (file: string) => string): RenamePlan {
  const grouped = new Map<string, RenameEdit[]>();
  for (const location of locations) {
    const file = path.resolve(root, location.file);
    grouped.set(file, [...(grouped.get(file) ?? []), { startUtf16: location.startUtf16, endUtf16: location.endUtf16, line: location.line, col: location.col, oldText: location.oldText, replacement: location.replacement }]);
  }
  const files = [...grouped].map(([file, edits]): RenameFilePlan => ({ path: path.relative(root, file).split(path.sep).join('/'), snapshot: Buffer.from(read(file)).toString('base64'), edits: edits.sort((left, right) => left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16) })).sort((left, right) => left.path.localeCompare(right.path));
  return { root, symbol, from, to, files };
}

function refusal(error: RenamePreflightError, received: string): InvocationError {
  return { category: 'invocation', code: error.code, problems: [{ field: '<symbol>', received: `${error.site}: ${error.message}`, expected: 'a rename without an unsupported site or name conflict', next: 'Choose a different symbol or replacement identifier, then retry rename.' }] };
}

function renderFile(file: RenameFilePlan) {
  return { element: 'file', attributes: { path: file.path, sites: file.edits.length }, text: file.edits.map((edit) => `${edit.line}:${edit.col}  ${edit.oldText} → ${edit.replacement}`).join('\n') };
}

function strings(value: boolean | number | string | string[] | undefined): string[] | undefined { return Array.isArray(value) ? value : undefined; }
function invalid(message: string, received: string, expected: string): InvocationError { return { category: 'invocation', code: 'cannot-rename', problems: [{ field: '<symbol>', received, expected: `${expected}; ${message}`, next: 'Choose a symbol TypeScript can rename, then retry.' }] }; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export default handler;
