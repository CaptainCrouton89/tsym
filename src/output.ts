import type { Answer, Completion, InvocationError, OutputNode, ToolError } from './commands/types.js';

/** Assembles chrome — help and error blocks — whose body is already rendered markup. Answer data goes through renderNode instead. */
export function xml(name: string, attributes: Record<string, string | number | boolean | undefined> = {}, body = ''): string {
  const rendered = Object.entries(attributes).filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`).join('');
  return body === '' ? `<${name}${rendered}/>` : `<${name}${rendered}>\n${body}\n</${name}>`;
}

/** Output is XML-shaped prose for an agent, never parsed as XML; only a double quote inside an attribute value is escaped, so the value's boundary stays readable. */
export function escapeAttribute(value: string): string { return value.replace(/"/g, '&quot;'); }

export function renderCompletion(completion: Completion, json: boolean): { stdout: string; stderr: string; exitCode: 0 | 1 | 2 | 3 } {
  const exitCode = completionCode(completion);
  const payload = json ? JSON.stringify(completion) + '\n' : render(completion) + '\n';
  const stdout = payload;
  const stderr = receipt(completion);
  return { stdout, stderr, exitCode };
}

export function completionCode(completion: Completion): 0 | 1 | 2 | 3 {
  if (isAnswer(completion)) return completion.count > 0 ? 0 : 1;
  if (completion.category === 'invocation') return 2;
  return 3;
}

function render(completion: Completion): string {
  if (isAnswer(completion)) return nodes(completion.data);
  if (completion.category === 'invocation') return renderInvocationError(completion);
  return renderToolError(completion);
}

function nodes(data: Answer['data']): string { return (Array.isArray(data) ? data : [data]).map(renderNode).join('\n'); }

export function renderNode(node: OutputNode): string {
  const attributes = Object.entries(node.attributes ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`).join('');
  const body = [node.text ?? '', ...(node.children ?? []).map(renderNode)].filter(Boolean).join('\n');
  return body === '' ? `<${node.element}${attributes}/>` : `<${node.element}${attributes}>\n${body}\n</${node.element}>`;
}

function renderInvocationError(error: InvocationError): string {
  const body = error.problems.map((problem) => {
    const expected = problem.expected.endsWith('.') ? problem.expected : `${problem.expected}.`;
    return `${problem.field}: received ${problem.received}; expected ${expected}\nNext: ${problem.next ?? ''}`;
  }).join('\n');
  return xml('error', { code: error.code }, body);
}

function renderToolError(error: ToolError): string {
  const lines = [error.message, error.received ? `received: ${error.received}` : null, error.expected ? `expected: ${error.expected}` : null, error.logPath ? `log: ${error.logPath}` : null, error.next ? `Next: ${error.next}` : null].filter((line): line is string => line !== null);
  return xml('error', { code: error.code, ...error.attributes }, lines.join('\n'));
}

function receipt(completion: Completion): string {
  if (isAnswer(completion)) {
    const answer = completion as Answer & { startupMs?: number };
    const base = answer.receipt ?? `${answer.count} answer${answer.count === 1 ? '' : 's'}, 0 ms`;
    return answer.startupMs === undefined ? base : `${base} (server started, ${answer.startupMs} ms)`;
  }
  return completion.category === 'invocation' ? `invocation rejected, 0 ms` : `tool failed, 0 ms`;
}

function isAnswer(completion: Completion): completion is Answer { return !('category' in completion); }
