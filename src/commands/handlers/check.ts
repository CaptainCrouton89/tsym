import { existsSync } from 'node:fs';
import path from 'node:path';
import { matchesGlob, Workspace } from '../../core/workspace.js';
import { diagnosticsForFiles, type CheckerDiagnostic } from '../../ts7/checker.js';
import type { SemanticHandler } from '../handlers.js';
import type { InvocationError, ToolError } from '../types.js';

const handler: SemanticHandler = async (context, invocation) => {
  const started = performance.now();
  try {
    await context.projects.bootstrap();
    const paths = invocation.input.args;
    const files = paths.length > 0 ? await explicitFiles(context, invocation, paths) : undefined;
    const diagnostics = diagnosticsForFiles(context.program, context.root, await diagnosticScopes(context, files));
    const filtered = finish(diagnostics, invocation);
    const limit = invocation.input.flags['--limit'] as number | undefined;
    const shown = limit === undefined ? filtered : filtered.slice(0, limit);
    const capped = shown.length < filtered.length;
    const errors = filtered.filter((diagnostic) => diagnostic.severity === 'error').length;
    const warnings = filtered.filter((diagnostic) => diagnostic.severity === 'warning').length;
    const suggestions = filtered.filter((diagnostic) => diagnostic.severity === 'suggestion').length;
    return {
      data: { element: 'check', attributes: { scope: paths.length === 0 ? 'project' : paths.join(' '), count: filtered.length, shown: capped ? shown.length : undefined, errors, warnings, suggestions, ms: Math.round(performance.now() - started) }, children: shown.map(renderDiagnostic) },
      count: filtered.length,
      receipt: capped
        ? `${shown.length} of ${filtered.length} check rows shown, limit ${limit}, ${Math.round(performance.now() - started)} ms`
        : `${shown.length} diagnostic${shown.length === 1 ? '' : 's'}, ${Math.round(performance.now() - started)} ms`,
    };
  } catch (error) {
    return failure(error);
  }
};

async function explicitFiles(context: Parameters<SemanticHandler>[0], invocation: Parameters<SemanticHandler>[1], inputs: readonly string[]): Promise<string[]> {
  const workspace = new Workspace(context.root, null, 'none');
  const candidates = workspace.files().map((file) => path.join(context.root, file));
  const files: string[] = [];
  for (const input of inputs) {
    const glob = hasGlob(input);
    const matches = glob
      ? candidates.filter((file) => matchesGlob(relative(invocation.cwd, file), input))
      : [path.resolve(invocation.cwd, input)];
    if (matches.length === 0 || !glob && !existsSync(matches[0]!)) throw invocationFailure('no-such-path', `${input} does not exist.`, input, 'an existing TypeScript file or glob with matches');
    for (const file of matches) {
      if (!existsSync(file)) throw invocationFailure('no-such-path', `${input} does not exist.`, input, 'an existing TypeScript file');
      if (!await context.projects.membership(file)) throw invocationFailure('not-in-program', `${relative(context.root, file)} exists but is not part of a TypeScript project under ${context.root}.`, input, 'a file listed by a project tsconfig.json');
      if (!files.includes(file)) files.push(file);
    }
  }
  return files;
}

async function diagnosticScopes(context: Parameters<SemanticHandler>[0], files: readonly string[] | undefined): Promise<Array<{ config: string; files: string[] }>> {
  const candidates = files ?? [...new Set(context.projects.records().flatMap((project) => [...project.files]))];
  const scopes = new Map<string, string[]>();
  for (const file of candidates) {
    const project = await context.projects.membership(file);
    if (!project) continue;
    const owned = scopes.get(project.config) ?? [];
    owned.push(file);
    scopes.set(project.config, owned);
  }
  return [...scopes].map(([config, owned]) => ({ config, files: owned }));
}

function finish(diagnostics: readonly CheckerDiagnostic[], invocation: Parameters<SemanticHandler>[1]): CheckerDiagnostic[] {
  const errorsOnly = invocation.input.flags['--errors-only'] === true;
  const include = (invocation.input.flags['--in'] as string[] | undefined) ?? [];
  const exclude = (invocation.input.flags['--exclude'] as string[] | undefined) ?? [];
  return diagnostics
    .filter((diagnostic) => !errorsOnly || diagnostic.severity === 'error')
    .filter((diagnostic) => (include.length === 0 || include.some((glob) => matchesGlob(diagnostic.file, glob))) && !exclude.some((glob) => matchesGlob(diagnostic.file, glob)))
    .sort(compare);
}

function renderDiagnostic(diagnostic: CheckerDiagnostic) {
  return { element: 'diagnostic', attributes: { at: `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`, severity: diagnostic.severity, code: diagnostic.code }, text: diagnostic.message };
}

function compare(left: CheckerDiagnostic, right: CheckerDiagnostic): number {
  return (left.file < right.file ? -1 : left.file > right.file ? 1 : 0) || left.line - right.line || left.column - right.column || left.code - right.code;
}

function hasGlob(value: string): boolean { return /[*?[{]/.test(value); }
function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }

function invocationFailure(code: string, message: string, _received: string, expected: string): InvocationError {
  return { category: 'invocation', code, problems: [{ field: 'path', received: message, expected, next: 'Pass a file listed by the loaded TypeScript project.' }] };
}

function failure(error: unknown): InvocationError | ToolError {
  if (isCompletionError(error)) return error;
  return { category: 'tool', code: 'typescript-error', message: 'TypeScript could not answer the diagnostic query.', received: error instanceof Error ? error.message : String(error), expected: 'successful TypeScript Program diagnostics', next: 'Read the server log, then retry.' };
}

function isCompletionError(value: unknown): value is InvocationError | ToolError {
  return typeof value === 'object' && value !== null && 'category' in value;
}

export default handler;
