import { DeclarationError } from '../core/declarations.js';
import type { SemanticContext } from '../server/context.js';
import type { Completion, HandlerName, Invocation, InvocationError } from './types.js';

/** A leaf handler answers, or returns an invocation error (exit 2) or a tool error (exit 3). It never writes output. */
export type SemanticHandler = (context: SemanticContext, invocation: Invocation) => Promise<Completion>;

const modules: Record<HandlerName, () => Promise<{ default: SemanticHandler }>> = {
  outline: () => import('./handlers/outline.js'), find: () => import('./handlers/find.js'), show: () => import('./handlers/show.js'), type: () => import('./handlers/type.js'), inspect: () => import('./handlers/inspect.js'), query: () => import('./handlers/query.js'), search: () => import('./handlers/search.js'), check: () => import('./handlers/check.js'), rename: () => import('./handlers/rename.js'), 'server-status': () => import('./handlers/server-status.js'), 'server-stop': () => import('./handlers/server-stop.js'), 'server-reload': () => import('./handlers/server-reload.js'),
};

export async function executeSemantic(context: SemanticContext, invocation: Invocation): Promise<Completion> {
  const handler = invocation.declaration.handler;
  if (!handler) return { category: 'tool', code: 'not-implemented', message: `tsym ${invocation.path.join(' ')} has no handler.`, next: 'Register an executable leaf handler.' };
  try {
    return await (await modules[handler]()).default(context, invocation);
  } catch (error) {
    if (error instanceof DeclarationError) return declarationError(error, invocation);
    throw error;
  }
}

/**
 * A resolver rejection is the caller's input being wrong, not the tool failing: exit 2 with the leaf's `-h` as
 * the next step. Handlers may let `DeclarationError` propagate and rely on this mapping, or return an
 * `InvocationError` themselves when they know a sharper field or next step.
 */
export function declarationError(error: DeclarationError, invocation: Invocation): InvocationError {
  const leaf = `tsym ${invocation.path.join(' ')}`;
  const expected: Record<DeclarationError['code'], string> = {
    'no-such-path': 'an existing file or directory under --root',
    'not-in-program': 'a file that a tsconfig under --root includes',
    'unresolvable-symbol': 'a declaration name, qualified member name, or path:line:col address',
    'ambiguous-symbol': 'one canonical address',
    'invalid-address': 'path:line:col with both coordinates positive, or path:0:0 for a module',
  };
  const next = error.code === 'ambiguous-symbol' && error.candidates.length > 0
    ? `Pass one of: ${error.candidates.join(' ')}`
    : `Run \`${leaf} -h\` for the accepted input forms.`;
  return { category: 'invocation', code: error.code, problems: [{ field: invocation.declaration.argument?.name ?? 'argument', received: error.message, expected: expected[error.code], next }] };
}
