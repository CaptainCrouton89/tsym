import { existsSync } from 'node:fs';
import path from 'node:path';
import { DeclarationError, type DeclarationRecord } from '../../core/declarations.js';
import { declarationSpans, declarationText, lineCount, navto, navtree, normalKind, symbolAt, type Span } from '../../read/read.js';
import type { SemanticContext } from '../../server/context.js';
import type { SemanticHandler } from '../handlers.js';

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const resolved = [];
  for (const input of invocation.input.args) {
    validateAddress(context, input);
    resolved.push(await resolve(context, input));
  }
  const rendered: Array<{ element: string; attributes: Record<string, string | number>; text: string }> = []; 
  for (const declaration of resolved) {
    const source = context.source.read(declaration.file);
    const declarationSpans = declaration.location.line === 0 ? [] : await spans(context, declaration);
    const text = declaration.location.line === 0 ? source : declarationSpans.map((span) => declarationText(source, span, normalKind(declaration.kind))).join('\n');
    const lines = declaration.location.line === 0 ? source.split('\n').length - (source.endsWith('\n') ? 1 : 0) : declarationSpans.reduce((total, span) => total + lineCount(source, span), 0);
    rendered.push({ element: 'symbol', attributes: { at: declaration.address, name: declaration.name, kind: normalKind(declaration.kind), lines }, text });
  }
  const limit = invocation.input.flags['--limit'] as number | undefined;
  const shown = limit === undefined ? rendered : rendered.slice(0, limit);
  return { data: { element: 'show', attributes: { count: shown.length }, children: shown }, count: shown.length, receipt: `${shown.length} show declaration${shown.length === 1 ? '' : 's'}${limit !== undefined && rendered.length > shown.length ? `, limit ${limit}` : ''}, ${Math.round(performance.now() - started)} ms` };
};

async function spans(context: SemanticContext, declaration: DeclarationRecord): Promise<Span[]> {
  return declarationSpans(await navtree(context, declaration.file), declaration);
}

async function resolve(context: SemanticContext, input: string): Promise<DeclarationRecord> {
  if (/^(.*):(\d+):(\d+)$/.test(input)) return context.resolver.resolve(input);
  const qualified = input.includes('.');
  const name = qualified ? input.slice(input.lastIndexOf('.') + 1) : input;
  const records: DeclarationRecord[] = [];
  for (const candidate of await navto(context, name)) {
    if (candidate.name !== name) continue;
    const declaration = await context.resolver.fromFileSpan(candidate);
    const source = context.source.read(candidate.file);
    const nested = symbolAt(context.root, candidate.file, await navtree(context, candidate.file), source, declaration.address)?.qualifiedName ?? declaration.qualifiedName;
    if ((qualified && nested !== input) || (!qualified && nested.includes('.'))) continue;
    const resolved = await context.resolver.resolve(declaration.address);
    if (!records.some((record) => record.address === resolved.address)) records.push(resolved);
  }
  if (records.length === 1) return records[0]!;
  if (records.length === 0) throw new DeclarationError('unresolvable-symbol', `No declaration matches ${input}.`);
  throw new DeclarationError('ambiguous-symbol', `${input} is ambiguous.`, records.map((record) => record.address));
}

function validateAddress(context: SemanticContext, input: string): void {
  const match = /^(.*):(\d+):(\d+)$/.exec(input);
  if (!match || (match[2] === '0' && match[3] === '0')) return;
  const file = path.resolve(context.root, match[1]!);
  if (!existsSync(file)) return;
  const line = Number(match[2]);
  const column = Number(match[3]);
  const content = context.source.read(file).split('\n');
  if (line < 1 || column < 1 || line > content.length || column > content[line - 1]!.length + 1) throw new DeclarationError('invalid-address', `${input} is outside the source text.`);
}

export default handler;
