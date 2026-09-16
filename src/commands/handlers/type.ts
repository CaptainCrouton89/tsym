import { DeclarationError, type DeclarationRecord } from '../../core/declarations.js';
import { normalKind } from '../../read/read.js';
import { typeAt } from '../../ts7/checker.js';
import type { SemanticHandler } from '../handlers.js';
import type { ToolError } from '../types.js';

const handler: SemanticHandler = async (context, invocation) => {
  try {
    await context.projects.bootstrap();
    const declarations: DeclarationRecord[] = [];
    for (const input of invocation.input.args) declarations.push(await context.resolver.resolve(input));
    const includeDefinition = invocation.input.flags['--def'] === true;
    const symbols: Array<{ element: string; attributes: Record<string, string | undefined>; text?: string; children?: Array<{ element: string; attributes?: Record<string, string>; text: string }> }> = [];
    let answers = 0;

    for (const declaration of declarations) {
      const project = await context.projects.membership(declaration.file);
      if (!project) throw new DeclarationError('not-in-program', `${declaration.location.path} exists but is not part of a TypeScript project under ${context.root}`);
      const answer = typeAt(context.program, context.root, project.config, declaration.file, declaration.nameSpan.start, { ...declaration, kind: normalKind(declaration.kind) });
      if (answer !== null) answers++;
      symbols.push(renderSymbol(declaration, answer, includeDefinition));
    }

    return { data: { element: 'type', children: symbols }, count: answers };
  } catch (error) {
    if (error instanceof DeclarationError) throw error;
    return failure(error);
  }
};

function renderSymbol(declaration: DeclarationRecord, answer: ReturnType<typeof typeAt>, includeDefinition: boolean) {
  const attributes = {
    at: declaration.address,
    name: declaration.name,
    kind: normalKind(answer?.kind ?? declaration.kind),
    modifiers: answer?.modifiers,
    typeAt: includeDefinition && answer && answer.definitions.length > 0 ? answer.definitions.join(' ') : undefined,
  };
  if (answer === null) return { element: 'symbol', attributes };
  const children = [documentation(answer.documentation), ...answer.tags.map((tag) => ({ element: 'tag', attributes: { name: tag.name }, text: tag.text }))].filter((node): node is { element: string; attributes?: Record<string, string>; text: string } => node !== null);
  return { element: 'symbol', attributes, text: answer.signature, children };
}

function documentation(text: string) { return text ? { element: 'doc', text } : null; }

function failure(error: unknown): ToolError {
  return { category: 'tool', code: 'typescript-error', message: 'TypeScript could not answer the type query.', received: error instanceof Error ? error.message : String(error), expected: 'a successful checker type query', next: 'Read the server log, then retry.' };
}

export default handler;
