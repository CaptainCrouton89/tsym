import type { SemanticHandler } from '../handlers.js';

const handler: SemanticHandler = async (_context, invocation) => ({
  category: 'tool',
  code: 'not-implemented',
  message: `symbols ${invocation.path.join(' ')} has no semantic handler yet.`,
  next: 'Retry after the corresponding leaf handler lands.',
});

export default handler;
