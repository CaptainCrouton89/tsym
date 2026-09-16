import { search } from '../../core/search.js';
import { openWorkspace } from '../../core/workspace.js';
import type { Answer, Invocation, ToolError } from '../types.js';
import type { SemanticHandler } from '../handlers.js';

export async function localSearch(invocation: Invocation): Promise<Answer | ToolError> {
  const result = await search(openWorkspace(invocation.root), invocation.input.args[0]!, {
    in: invocation.input.flags['--in'] as string[] | undefined,
    exclude: invocation.input.flags['--exclude'] as string[] | undefined,
    limit: invocation.input.flags['--limit'] as number | undefined,
  });
  return {
    data: {
      element: 'search',
      attributes: { pattern: invocation.input.args[0]!, count: result.items.length },
      text: result.items.map((match) => `${match.path}:${match.start.line}:${match.start.col}  ${match.text}`).join('\n'),
    },
    count: result.items.length,
    receipt: `${result.items.length} search row${result.items.length === 1 ? '' : 's'}${result.receipt.truncated ? `, limit ${result.receipt.limit}` : ''}${result.receipt.excluded > 0 ? `, ${result.receipt.excluded} excluded` : ''}, ${result.receipt.elapsed_ms} ms`,
  };
}

const handler: SemanticHandler = async (_context, invocation) => localSearch(invocation);

export default handler;
