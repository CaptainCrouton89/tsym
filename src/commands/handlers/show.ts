import { escapeText, xml } from '../../output.js';
import type { DeclarationRecord } from '../../core/declarations.js';
import { declarationSpans, lineCount, navtree, normalKind, sourceSpan, type Span } from '../../read/read.js';
import type { SemanticContext } from '../../server/context.js';
import type { SemanticHandler } from '../handlers.js';

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const resolved = [];
  for (const input of invocation.input.args) resolved.push(await context.resolver.resolve(input));
  const rendered: string[] = [];
  for (const declaration of resolved) {
    const source = context.source.read(declaration.file);
    const declarationSpans = declaration.location.line === 0 ? [] : await spans(context, declaration);
    const text = declaration.location.line === 0 ? source : declarationSpans.map((span) => sourceSpan(source, span)).join('\n');
    const lines = declaration.location.line === 0 ? source.split('\n').length - (source.endsWith('\n') ? 1 : 0) : declarationSpans.reduce((total, span) => total + lineCount(source, span), 0);
    rendered.push(xml('symbol', { at: declaration.address, name: declaration.name, kind: normalKind(declaration.kind), lines }, escapeText(text)));
  }
  const limit = invocation.input.flags['--limit'] as number | undefined;
  const shown = limit === undefined ? rendered : rendered.slice(0, limit);
  return { element: 'show', attributes: { count: shown.length }, body: shown.join('\n'), count: shown.length, receipt: `${shown.length} show declaration${shown.length === 1 ? '' : 's'}${limit !== undefined && rendered.length > shown.length ? `, limit ${limit}` : ''}, ${Math.round(performance.now() - started)} ms` };
};

async function spans(context: SemanticContext, declaration: DeclarationRecord): Promise<Span[]> {
  return declarationSpans(await navtree(context, declaration.file), declaration);
}

export default handler;
