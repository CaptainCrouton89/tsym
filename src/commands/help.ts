import { xml, escapeText } from '../output.js';
import { commandTree } from './tree.js';
import type { CommandDeclaration, FlagDeclaration } from './types.js';

export function renderHelp(node: CommandDeclaration, serverState = '<server state="stopped"/>'): string {
  const lines: string[] = [];
  if (node.model) lines.push(`<model>\n${escapeText(node.model)}${node === commandTree || node.state ? `\n\n${serverState}` : ''}\n</model>`);
  if (serverState && node !== commandTree && !node.state) lines.push(serverState);
  if (node.children) lines.push(...node.children.map((child) => `<subcommand name="${child.name}" description="${escapeText(child.description)}" whenToUse="${escapeText(child.whenToUse ?? '')}"/>`));
  if (node.argument || node.flags?.length) lines.push(`<input>\n${[node.argument ? argument(node.argument) : null, ...(node.flags ?? []).map(flag)].filter((line): line is string => line !== null).join('\n')}\n</input>`);
  if (node.output) lines.push(`<output>${escapeText(node.output)}</output>`);
  if (node.effects) lines.push(`<effects>${escapeText(node.effects)}</effects>`);
  if (node === commandTree) {
    lines.push('<globals>\n  <flag name="--root" type="path">Workspace root, overriding discovery from the current directory.</flag>\n  <flag name="--json" type="bool">Raw JSON on stdout for programmatic consumers.</flag>\n</globals>');
    lines.push('<io>Flags and positional arguments on input. Stdout is one named XML block per call. One receipt goes to stderr on every call. Exit 0 with results, 1 with none, 2 when the invocation was wrong, 3 when the tool could not answer.</io>');
  }
  return xml('command', { name: node.name, description: node.description }, lines.join('\n'));
}

function argument(declaration: NonNullable<CommandDeclaration['argument']>): string { return `  <arg name="${declaration.name}" repeat="${declaration.repeat}">${escapeText(declaration.description)}</arg>`; }

function flag(declaration: FlagDeclaration): string {
  const attrs = [`name="${declaration.name}"`, `type="${declaration.type}"`, declaration.repeat ? 'repeat="yes"' : null, declaration.default !== undefined ? `default="${declaration.default}"` : null].filter(Boolean).join(' ');
  return `  <flag ${attrs}>${escapeText(declaration.description)}</flag>`;
}
