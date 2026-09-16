import { renderHelp } from './commands/help.js';
import { parseInvocation } from './commands/tree.js';
import type { Completion, Invocation } from './commands/types.js';
import { renderCompletion } from './output.js';
import { invokeResident, serverReload, serverStatus, serverStop } from './server/client.js';

async function main(argv: string[]): Promise<number> {
  const parsed = parseInvocation(argv);
  if ('help' in parsed) {
    const state = await helpState(rootFlag(argv));
    return emit({ element: 'command', raw: renderHelp(parsed.help, state), count: 1 }, false);
  }
  if ('category' in parsed) return emit(parsed, false);
  return emit(await dispatch(parsed), parsed.json);
}

async function dispatch(invocation: Invocation): Promise<Completion> {
  switch (invocation.declaration.handler) {
    case 'server-status': return serverStatus(invocation.root);
    case 'server-stop': return serverStop(invocation.root);
    case 'server-reload': return serverReload(invocation.root);
    default: return invokeResident(invocation);
  }
}

async function helpState(root: string | undefined): Promise<string> {
  const status = await serverStatus(root);
  if ('category' in status) return '<server state="unavailable"/>';
  const attributes = status.attributes ?? {};
  if (attributes.state === 'stopped') return '<server state="stopped"/>';
  return `<server ${Object.entries(attributes).map(([key, value]) => `${key}="${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join(' ')}/>`;
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
