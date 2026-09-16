import path from 'node:path';
import { matchesPathFilters } from '../../core/receipt.js';
import type { RenameEdit, RenameFilePlan, RenamePlan } from '../rename-apply.js';
import type { Answer, InvocationError } from '../types.js';
import type { SemanticHandler } from '../handlers.js';

interface RenameLocation {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  prefixText?: string;
  suffixText?: string;
}

interface RenameResponse {
  info?: { canRename?: boolean; localizedErrorMessage?: string };
  locs?: { file: string; locs: RenameLocation[] }[];
}

const handler: SemanticHandler = async (context, invocation) => {
  const [input, newName] = invocation.input.args;
  if (!input || !newName) return invalid('rename needs a symbol and a replacement identifier.', input ?? 'none', 'exactly two values: <symbol> <newName>');

  await context.projects.bootstrap();
  const declaration = await context.resolver.resolve(input);
  try {
    const response = await context.session.withOpen(declaration.file, async () => {
      const configured = await context.session.request('configure', { preferences: { providePrefixAndSuffixTextForRename: true } });
      if (configured.success === false) throw new Error(configured.message ?? 'TypeScript rejected the rename preferences.');
      const result = await context.session.request('rename', {
        file: declaration.file,
        line: declaration.location.line,
        offset: declaration.location.col,
        findInStrings: false,
        findInComments: false,
      });
      if (result.success === false) throw new Error(result.message ?? 'TypeScript rejected the rename request.');
      return result.body as RenameResponse;
    });
    if (response.info?.canRename === false) {
      return invalid(response.info.localizedErrorMessage ?? 'TypeScript cannot rename this symbol.', input, 'a symbol TypeScript can rename');
    }

    const plan = buildPlan(context.root, declaration.address, declaration.name, newName, response.locs ?? [], context.source.read.bind(context.source));
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
    return { category: 'tool', code: 'typescript-error', message: `TypeScript could not prepare this rename: ${message(error)}.`, received: input, expected: 'compiler-provided rename locations', next: 'Read server status and retry after repairing the workspace.' };
  }
};

function buildPlan(root: string, symbol: string, from: string, to: string, locations: readonly { file: string; locs: RenameLocation[] }[], read: (file: string) => string): RenamePlan {
  const files = locations.map((location): RenameFilePlan => {
    const file = path.resolve(location.file);
    const source = read(file);
    const display = path.relative(root, file).split(path.sep).join('/');
    const edits = location.locs.map((location) => editFromLocation(source, location, to)).sort((left, right) => left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16);
    return { path: display, snapshot: Buffer.from(source).toString('base64'), edits };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { root, symbol, from, to, files };
}

function editFromLocation(source: string, location: RenameLocation, newName: string): RenameEdit {
  const start = utf16Offset(source, location.start);
  const end = utf16Offset(source, location.end);
  return {
    startUtf16: start,
    endUtf16: end,
    line: location.start.line,
    col: location.start.offset,
    oldText: source.slice(start, end),
    replacement: `${location.prefixText ?? ''}${newName}${location.suffixText ?? ''}`,
  };
}

function utf16Offset(source: string, position: { line: number; offset: number }): number {
  let start = 0;
  for (let line = 1; line < position.line; line++) {
    const newline = source.indexOf('\n', start);
    if (newline < 0) throw new Error(`TypeScript returned a rename location after the end of the source at ${position.line}:${position.offset}.`);
    start = newline + 1;
  }
  const result = start + position.offset - 1;
  if (result < start || result > source.length) throw new Error(`TypeScript returned an invalid rename location at ${position.line}:${position.offset}.`);
  return result;
}

function renderFile(file: RenameFilePlan) {
  return { element: 'file', attributes: { path: file.path, sites: file.edits.length }, text: file.edits.map((edit) => `${edit.line}:${edit.col}  ${edit.oldText} → ${edit.replacement}`).join('\n') };
}

function strings(value: boolean | number | string | string[] | undefined): string[] | undefined { return Array.isArray(value) ? value : undefined; }
function invalid(message: string, received: string, expected: string): InvocationError { return { category: 'invocation', code: 'cannot-rename', problems: [{ field: '<symbol>', received, expected: `${expected}; ${message}`, next: 'Choose a symbol TypeScript can rename, then retry.' }] }; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export default handler;
