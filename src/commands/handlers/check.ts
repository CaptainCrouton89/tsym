import { existsSync } from 'node:fs';
import path from 'node:path';
import { xml, escapeText } from '../../output.js';
import { matchesGlob, Workspace } from '../../core/workspace.js';
import type { DiagnosticEvent } from '../../server/tsserver.js';
import type { SemanticHandler } from '../handlers.js';
import type { InvocationError, ToolError } from '../types.js';

interface Response { success?: boolean; body?: unknown; message?: string; }
interface ProtocolDiagnostic {
  start?: { line?: number; offset?: number };
  startLocation?: { line?: number; offset?: number };
  code?: number;
  category?: string | number;
  message?: string | MessageChain;
  text?: string | MessageChain;
  messageText?: string | MessageChain;
}
interface MessageChain { messageText: string; next?: readonly MessageChain[]; }
interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: string;
  code: number;
  message: string;
}

const handler: SemanticHandler = async (context, invocation) => {
  const started = performance.now();
  try {
    await context.projects.bootstrap();
    const paths = invocation.input.args;
    const diagnostics = paths.length > 0
      ? await diagnosticsForFiles(context, await explicitFiles(context, paths))
      : await diagnosticsForProjects(context);
    const filtered = finish(diagnostics, invocation);
    const errors = filtered.filter((diagnostic) => diagnostic.severity === 'error').length;
    const warnings = filtered.filter((diagnostic) => diagnostic.severity === 'warning').length;
    const suggestions = filtered.filter((diagnostic) => diagnostic.severity === 'suggestion').length;
    const body = filtered.map(renderDiagnostic).join('\n');
    return {
      element: 'check',
      attributes: { scope: paths.length === 0 ? 'project' : paths.join(' '), errors, warnings, suggestions, ms: Math.round(performance.now() - started) },
      body,
      count: filtered.length,
      receipt: `${filtered.length} diagnostic${filtered.length === 1 ? '' : 's'}, ${Math.round(performance.now() - started)} ms`,
    };
  } catch (error) {
    return failure(error);
  }
};

async function explicitFiles(context: Parameters<SemanticHandler>[0], inputs: readonly string[]): Promise<string[]> {
  const workspace = new Workspace(context.root, null, 'none');
  const candidates = workspace.files().map((file) => path.join(context.root, file));
  const files: string[] = [];
  for (const input of inputs) {
    const glob = hasGlob(input);
    const matches = glob
      ? candidates.filter((file) => matchesGlob(relative(context.root, file), input))
      : [path.resolve(context.root, input)];
    if (matches.length === 0 || !glob && !existsSync(matches[0]!)) throw invocationFailure('no-such-path', `${input} does not exist.`, input, 'an existing TypeScript file or glob with matches');
    for (const file of matches) {
      if (!existsSync(file)) throw invocationFailure('no-such-path', `${input} does not exist.`, input, 'an existing TypeScript file');
      if (!await context.projects.membership(file)) throw invocationFailure('not-in-program', `${relative(context.root, file)} exists but is not part of a TypeScript project under ${context.root}.`, input, 'a file listed by a project tsconfig.json');
      if (!files.includes(file)) files.push(file);
    }
  }
  return files;
}

async function diagnosticsForFiles(context: Parameters<SemanticHandler>[0], files: readonly string[]): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    const found = await context.session.withOpen(file, async () => [
      ...await synchronousDiagnostics(context, 'syntacticDiagnosticsSync', file),
      ...await synchronousDiagnostics(context, 'semanticDiagnosticsSync', file),
    ]);
    diagnostics.push(...found);
  }
  return diagnostics;
}

async function synchronousDiagnostics(context: Parameters<SemanticHandler>[0], command: 'syntacticDiagnosticsSync' | 'semanticDiagnosticsSync', file: string): Promise<Diagnostic[]> {
  const response = await context.session.request(command, { file, includeLinePosition: true }) as Response;
  if (response.success === false) throw new Error(response.message ?? `TypeScript rejected ${command}.`);
  return Array.isArray(response.body) ? (response.body as ProtocolDiagnostic[]).map((diagnostic) => normalize(file, diagnostic, context.root)) : []; 
}

async function diagnosticsForProjects(context: Parameters<SemanticHandler>[0]): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const project of context.projects.records()) {
    if (!project.bootstrap) continue;
    const events = await context.session.withOpen(project.bootstrap, () => context.session.diagnosticsForProject(project.bootstrap!));
    diagnostics.push(...eventDiagnostics(context.root, events), ...configDiagnostics(context.root, context.session.drainEvents('configFileDiag')));
  }
  return unique(diagnostics);
}

function eventDiagnostics(root: string, events: readonly DiagnosticEvent[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const event of events) {
    const file = path.resolve(event.file);
    if (!inside(root, file)) continue;
    for (const diagnostic of event.diagnostics as ProtocolDiagnostic[]) diagnostics.push(normalize(file, diagnostic, root));
  }
  return diagnostics;
}

function configDiagnostics(root: string, events: readonly { body?: unknown }[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const event of events) {
    const body = event.body as { configFile?: string; triggerFile?: string; diagnostics?: ProtocolDiagnostic[] } | undefined;
    const file = body?.configFile ?? body?.triggerFile;
    if (!file || !inside(root, path.resolve(file))) continue;
    for (const diagnostic of body?.diagnostics ?? []) diagnostics.push(normalize(path.resolve(file), diagnostic, root));
  }
  return diagnostics;
}

function normalize(file: string, diagnostic: ProtocolDiagnostic, root?: string): Diagnostic {
  const base = root ?? path.dirname(path.dirname(file));
  return {
    file: relative(base, file),
    line: diagnostic.start?.line ?? diagnostic.startLocation?.line ?? 0,
    column: diagnostic.start?.offset ?? diagnostic.startLocation?.offset ?? 0,
    severity: severity(diagnostic.category),
    code: diagnostic.code ?? 0,
    message: flatten(diagnostic.message ?? diagnostic.text ?? diagnostic.messageText ?? ''),
  };
}

function finish(diagnostics: readonly Diagnostic[], invocation: Parameters<SemanticHandler>[1]): Diagnostic[] {
  const errorsOnly = invocation.input.flags['--errors-only'] === true;
  const include = (invocation.input.flags['--in'] as string[] | undefined) ?? [];
  const exclude = (invocation.input.flags['--exclude'] as string[] | undefined) ?? [];
  const limit = invocation.input.flags['--limit'] as number | undefined;
  return diagnostics
    .filter((diagnostic) => !errorsOnly || diagnostic.severity === 'error')
    .filter((diagnostic) => (include.length === 0 || include.some((glob) => matchesGlob(diagnostic.file, glob))) && !exclude.some((glob) => matchesGlob(diagnostic.file, glob)))
    .sort(compare)
    .slice(0, limit);
}

function renderDiagnostic(diagnostic: Diagnostic): string {
  return xml('diagnostic', { at: `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`, severity: diagnostic.severity, code: diagnostic.code }, escapeText(diagnostic.message));
}

function severity(category: ProtocolDiagnostic['category']): string {
  if (category === 0 || category === 'warning') return 'warning';
  if (category === 1 || category === 'error') return 'error';
  if (category === 2 || category === 'suggestion') return 'suggestion';
  return 'message';
}

function flatten(value: string | MessageChain): string {
  if (typeof value === 'string') return value;
  return [value.messageText, ...(value.next ?? []).map(flatten)].join('\n');
}

function unique(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...new Map(diagnostics.map((diagnostic) => [`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.severity}:${diagnostic.message}`, diagnostic])).values()];
}

function compare(left: Diagnostic, right: Diagnostic): number {
  return (left.file < right.file ? -1 : left.file > right.file ? 1 : 0) || left.line - right.line || left.column - right.column || left.code - right.code;
}

function hasGlob(value: string): boolean { return /[*?[{]/.test(value); }
function inside(root: string, file: string): boolean { const value = path.relative(root, file); return value === '' || !value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value); }
function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }

function invocationFailure(code: string, message: string, received: string, expected: string): InvocationError {
  return { category: 'invocation', code, problems: [{ field: 'path', received, expected, next: 'Pass a file listed by the loaded TypeScript project.' }] };
}

function failure(error: unknown): InvocationError | ToolError {
  if (isCompletionError(error)) return error;
  return { category: 'tool', code: 'typescript-error', message: 'TypeScript could not answer the diagnostic query.', received: error instanceof Error ? error.message : String(error), expected: 'successful TypeScript diagnostic responses', next: 'Read the server log, then retry.' };
}

function isCompletionError(value: unknown): value is InvocationError | ToolError {
  return typeof value === 'object' && value !== null && 'category' in value;
}

export default handler;
