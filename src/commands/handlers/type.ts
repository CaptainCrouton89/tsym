import { xml, escapeText } from '../../output.js';
import { DeclarationError, type DeclarationRecord } from '../../core/declarations.js';
import type { SemanticHandler } from '../handlers.js';
import type { ToolError } from '../types.js';

interface QuickInfo {
  kind?: string;
  kindModifiers?: string;
  displayString?: string;
  documentation?: string | readonly DisplayPart[];
  tags?: readonly Tag[];
}

interface DisplayPart { text: string; }
interface Tag { name?: string; text?: string | readonly DisplayPart[]; }
interface FileSpan { file: string; start: { line: number; offset: number }; }
interface Response { success?: boolean; body?: unknown; message?: string; }

const handler: SemanticHandler = async (context, invocation) => {
  try {
    await context.projects.bootstrap();
    const declarations: DeclarationRecord[] = [];
    for (const input of invocation.input.args) declarations.push(await context.resolver.resolve(input));
    const includeDefinition = invocation.input.flags['--def'] === true;
    const symbols: string[] = [];
    let answers = 0;

    for (const declaration of declarations) {
      const result = await context.session.withOpen(declaration.file, async () => {
        const body = await context.session.quickinfo(position(declaration));
        const quickinfo = body && typeof body === 'object' ? body as QuickInfo : null;
        const definitions = includeDefinition ? await typeDefinitions(context, declaration) : [];
        return { quickinfo, definitions };
      });
      if (result.quickinfo !== null) answers++;
      symbols.push(renderSymbol(declaration, result.quickinfo, result.definitions));
    }

    return { element: 'type', body: symbols.join('\n'), count: answers };
  } catch (error) {
    return failure(error);
  }
};

async function typeDefinitions(context: Parameters<SemanticHandler>[0], declaration: DeclarationRecord): Promise<string[]> {
  const response = await context.session.request('typeDefinition', position(declaration)) as Response;
  if (response.success === false) throw new Error(response.message ?? 'TypeScript rejected typeDefinition.');
  const spans = Array.isArray(response.body) ? response.body as FileSpan[] : [];
  const addresses: string[] = [];
  for (const span of spans) addresses.push((await context.resolver.fromFileSpan(span)).address);
  return [...new Set(addresses)];
}

function position(declaration: DeclarationRecord): { file: string; line: number; offset: number } {
  return { file: declaration.file, line: declaration.location.line, offset: declaration.location.col };
}

function renderSymbol(declaration: DeclarationRecord, quickinfo: QuickInfo | null, definitions: readonly string[]): string {
  const attributes = {
    at: declaration.address,
    name: declaration.name,
    kind: quickinfo?.kind ?? declaration.kind,
    modifiers: quickinfo?.kindModifiers || undefined,
    typeAt: definitions.length > 0 ? definitions.join(' ') : undefined,
  };
  if (quickinfo === null) return xml('symbol', attributes);
  const body = [quickinfo.displayString ? escapeText(quickinfo.displayString) : '', documentation(quickinfo.documentation), ...tags(quickinfo.tags)].filter(Boolean).join('\n');
  return xml('symbol', attributes, body);
}

function documentation(value: QuickInfo['documentation']): string {
  const text = displayText(value);
  return text ? xml('doc', {}, escapeText(text)) : '';
}

function tags(values: QuickInfo['tags']): string[] {
  return (values ?? []).map((tag) => xml('tag', { name: tag.name ?? '' }, escapeText(displayText(tag.text))));
}

function displayText(value: string | readonly DisplayPart[] | undefined): string {
  return typeof value === 'string' ? value : (value ?? []).map((part) => part.text).join('');
}

function failure(error: unknown): ToolError {
  if (error instanceof DeclarationError) return { category: 'tool', code: error.code, message: error.message, received: error.message, expected: 'a declaration in the loaded TypeScript project', next: 'Pass a declaration address or name reported by symbols find.' };
  return { category: 'tool', code: 'typescript-error', message: 'TypeScript could not answer the type query.', received: error instanceof Error ? error.message : String(error), expected: 'a successful quickinfo or typeDefinition response', next: 'Read the server log, then retry.' };
}

export default handler;
