import { renderHelp } from './commands/help.js';
import { localSearch } from './commands/handlers/search.js';
import { applyRenamePlan, type RenameAnswer } from './commands/rename-apply.js';
import { parseInvocation } from './commands/tree.js';
import type { Answer, Completion, Invocation, OutputNode } from './commands/types.js';
import { renderCompletion, renderNode } from './output.js';
import { invokeResident, serverReload, serverStatus, serverStop } from './server/client.js';

async function main(argv: string[]): Promise<number> {
  const parsed = parseInvocation(argv);
  if ('help' in parsed) {
    const state = parsed.help.name === 'search' ? '' : await helpState(rootFlag(argv));
    process.stdout.write(renderHelp(parsed.help, state) + '\n');
    process.stderr.write('1 answer, 0 ms\n');
    return 0;
  }
  if ('category' in parsed) return emit(parsed, false);
  return emit(await dispatch(parsed), parsed.json);
}

async function dispatch(invocation: Invocation): Promise<Completion> {
  switch (invocation.declaration.handler) {
    case 'server-status': return serverStatus(invocation.root);
    case 'server-stop': return serverStop(invocation.root);
    case 'server-reload': return serverReload(invocation.root);
    case 'search': return localSearch(invocation);
    case 'rename': return applyRename(invocation);
    default: return invokeResident(invocation);
  }
}

async function applyRename(invocation: Invocation): Promise<Completion> {
  const completion = await invokeResident(invocation);
  if (invocation.input.flags['--apply'] !== true || !isRenameAnswer(completion)) return completion;
  const applied = await applyRenamePlan(completion.renamePlan);
  if ('category' in applied) return applied;
  const stamp = (node: OutputNode): OutputNode => ({ ...node, attributes: { ...node.attributes, applied: true } });
  return { ...completion, data: Array.isArray(completion.data) ? [stamp(completion.data[0]!), ...completion.data.slice(1)] : stamp(completion.data) };
}

function isRenameAnswer(completion: Completion): completion is Answer & RenameAnswer { return !('category' in completion) && 'renamePlan' in completion; }

async function helpState(root: string | undefined): Promise<string> {
  const status = await serverStatus(root);
  if ('category' in status) return '<server state="unavailable"/>';
  const attributes = (Array.isArray(status.data) ? status.data[0]! : status.data).attributes ?? {};
  if (attributes.state === 'stopped') return '<server state="stopped"/>';
  return renderNode({ element: 'server', attributes });
}

function rootFlag(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root') return argv[index + 1];
    if (argv[index]?.startsWith('--root=')) return argv[index]!.slice('--root='.length);
  }
  return undefined;
}

function emit(completion: Completion, json: boolean): number {
  const rendered = renderCompletion(completion, json);
  if (rendered.stdout) process.stdout.write(rendered.stdout);
  process.stderr.write(rendered.stderr.endsWith('\n') ? rendered.stderr : rendered.stderr + '\n');
  return rendered.exitCode;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
  const completion: Completion = { category: 'tool', code: 'internal', message: 'symbols failed before completing the invocation.', next: 'Read the log from server status, then retry.' };
  const rendered = renderCompletion(completion, false);
  process.stderr.write(rendered.stderr.endsWith('\n') ? rendered.stderr : rendered.stderr + '\n');
  process.exit(rendered.exitCode);
});
