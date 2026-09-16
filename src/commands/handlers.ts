import type { SemanticContext } from '../server/context.js';
import type { Answer, HandlerName, Invocation, ToolError } from './types.js';

export type SemanticHandler = (context: SemanticContext, invocation: Invocation) => Promise<Answer | ToolError>;

const modules: Record<HandlerName, () => Promise<{ default: SemanticHandler }>> = {
  outline: () => import('./handlers/outline.js'), find: () => import('./handlers/find.js'), show: () => import('./handlers/show.js'), type: () => import('./handlers/type.js'), inspect: () => import('./handlers/inspect.js'), search: () => import('./handlers/search.js'), check: () => import('./handlers/check.js'), rename: () => import('./handlers/rename.js'), 'server-status': () => import('./handlers/server-status.js'), 'server-stop': () => import('./handlers/server-stop.js'), 'server-reload': () => import('./handlers/server-reload.js'),
};

export async function executeSemantic(context: SemanticContext, invocation: Invocation): Promise<Answer | ToolError> {
  const handler = invocation.declaration.handler;
  if (!handler) return { category: 'tool', code: 'not-implemented', message: `symbols ${invocation.path.join(' ')} has no handler.`, next: 'Register an executable leaf handler.' };
  return (await modules[handler]()).default(context, invocation);
}
