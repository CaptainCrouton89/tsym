import { search, type SearchResult } from '../../core/search.js';
import { openWorkspace } from '../../core/workspace.js';
import type { Answer, Invocation, InvocationError, ToolError } from '../types.js';
import type { SemanticHandler } from '../handlers.js';

export async function localSearch(invocation: Invocation): Promise<Answer | InvocationError | ToolError> {
  const pattern = invocation.input.args[0]!;
  let result: SearchResult;
  try {
    result = await search(openWorkspace(invocation.root), pattern, {
      in: invocation.input.flags['--in'] as string[] | undefined,
      exclude: invocation.input.flags['--exclude'] as string[] | undefined,
      limit: invocation.input.flags['--limit'] as number | undefined,
    });
  } catch (error) {
    if (isInvalidPattern(error)) return { category: 'invocation', code: 'invalid-pattern', problems: [{ field: '<pattern>', received: pattern, expected: `one ast-grep pattern that parses as a single TypeScript node; ${error.message}`, next: 'Wrap the fragment so it is one node, for example a class body, or use --in with a simpler pattern.' }] };
    throw error;
  }
  return {
    data: {
      element: 'search',
      attributes: { pattern, count: result.count, shown: result.receipt.truncated ? result.items.length : undefined },
      text: result.items.map((match) => `${match.path}:${match.start.line}:${match.start.col}  ${match.text}`).join('\n'),
    },
    count: result.count,
    receipt: `${result.receipt.truncated ? `${result.items.length} of ${result.count} search rows shown, limit ${result.receipt.limit}` : `${result.items.length} search row${result.items.length === 1 ? '' : 's'}`}${result.receipt.excluded > 0 ? `, ${result.receipt.excluded} excluded` : ''}, ${result.receipt.elapsed_ms} ms`,
  };
}

function isInvalidPattern(error: unknown): error is Error {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 'InvalidArg' && error.message.includes('Rule contains invalid pattern matcher.');
}

const handler: SemanticHandler = async (_context, invocation) => localSearch(invocation);

export default handler;
