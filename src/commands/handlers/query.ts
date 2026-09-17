import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LbugValue } from '@ladybugdb/core';
import { pathsForRoot } from '../../server/lifecycle.js';
import { ingestCommits } from '../../index/commits.js';
import { query, type QueryParameters } from '../../store/query.js';
import type { StoreRow } from '../../store/store.js';
import type { Completion, Invocation, InvocationError, ValidationProblem } from '../types.js';
import type { SemanticHandler } from '../handlers.js';

const address = /^(.*):(\d+):(\d+)$/;

const handler: SemanticHandler = async (context, invocation) => {
  const cypher = invocation.input.args[0] ?? '';
  if (cypher.trim() === '') return rejected('cypher', 'an empty query', 'one non-empty Cypher statement', 'Pass a Cypher statement as the positional argument or pipe one to `tsym query -`.');

  const bound = parametersFor(invocation);
  if ('error' in bound) return bound.error;
  const parameters = bound.parameters;
  if (invocation.input.flags['--since'] !== undefined) {
    const commits = commitsSince(context.root, invocation.input.flags['--since'] as string);
    if (!Array.isArray(commits)) return commits;
    if (!context.store) throw new Error('The query leaf requires the resident store and index state.');
    ingestCommits(context.root, context.store, commits);
    parameters.commits = commits;
  }

  const { store, index } = context;
  if (!store || !index) throw new Error('The query leaf requires the resident store and index state.');
  const started = performance.now();
  let records: StoreRow[];
  try {
    records = query(store, cypher, parameters);
  } catch (error) {
    if (error instanceof Error && error.message === 'Interrupted.') return { category: 'tool', code: 'query-timeout', message: error.message };
    return rejected('cypher', error instanceof Error ? error.message : String(error), 'a Cypher statement accepted by LadybugDB', 'Correct the query using the engine message and retry.');
  }

  const ordered = hasTopLevelOrderBy(cypher) ? records : orderDefault(records);
  const rows = ordered.map(renderRow);
  const limit = invocation.input.flags['--rows'] as number;
  const shown = limit === 0 ? rows : rows.slice(0, limit);
  const output = invocation.input.flags['--out'] as string | undefined;
  const complete = rows.join('\n');
  const resultPath = output === undefined
    ? shown.length < rows.length ? path.join(pathsForRoot(context.root).results, `${randomUUID()}.txt`) : undefined
    : path.resolve(invocation.cwd, output);
  if (resultPath !== undefined) writeFileSync(resultPath, complete === '' ? '' : `${complete}\n`, { mode: 0o600 });

  const unordered = !hasTopLevelOrderBy(cypher) && ordered.some((record) => addressFor(record) === undefined);
  const elapsed = Math.round(performance.now() - started);
  return {
    data: {
      element: 'query',
      attributes: { rows: rows.length, shown: shown.length, indexedAt: index.indexedAt, state: index.state, ms: elapsed },
      text: shown.join('\n'),
      children: shown.length < rows.length && resultPath !== undefined
        ? [{ element: 'truncated', attributes: { rows: rows.length, shown: shown.length, file: resultPath }, text: 'Re-run with --rows 0 for every row on stdout.' }]
        : undefined,
    },
    count: rows.length,
    receipt: `${shown.length} of ${rows.length} query row${rows.length === 1 ? '' : 's'}${unordered ? ', unordered' : ''}, ${elapsed} ms`,
  };
};

function parametersFor(invocation: Invocation): { parameters: QueryParameters } | { error: InvocationError } {
  const values: QueryParameters = {};
  const problems: ValidationProblem[] = [];
  const problem = (received: string, expected: string, next: string) => problems.push({ field: '--param', received, expected, next });
  for (const raw of (invocation.input.flags['--param'] as string[] | undefined) ?? []) {
    const separator = raw.indexOf('=');
    if (separator <= 0) { problem(raw, 'NAME=VALUE', 'Name the Cypher parameter before `=`.'); continue; }
    const name = raw.slice(0, separator);
    if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(name)) { problem(raw, 'NAME=VALUE with a Cypher parameter name', 'Use letters, digits, and underscores; the name cannot begin with a digit.'); continue; }
    if (name in values) { problem(raw, `one binding for $${name}`, 'Bind each parameter once.'); continue; }
    if (name === 'commits' && invocation.input.flags['--since'] !== undefined) { problem(raw, '$commits bound by --since', 'Remove --param commits or omit --since.'); continue; }
    values[name] = parseParameter(raw.slice(separator + 1));
  }
  if (problems.length > 0) return { error: { category: 'invocation', code: 'query-rejected', problems } };
  return { parameters: values };
}

function parseParameter(value: string): LbugValue {
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function commitsSince(root: string, ref: string): string[] | InvocationError {
  try {
    const output = execFileSync('git', ['rev-list', `${ref}..HEAD`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output.split('\n').filter(Boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rejected('--since', ref, 'a git ref reachable from this workspace', `Git could not resolve that ref: ${message}`);
  }
}

function renderRow(record: StoreRow): string {
  const entry = addressFor(record);
  const values = Object.entries(record)
    .filter(([name]) => !entry?.columns.includes(name))
    .map(([, value]) => renderValue(value));
  return [entry?.value, ...values].filter((value): value is string => value !== undefined).join('  ');
}

function addressFor(record: StoreRow): { value: string; columns: string[] } | undefined {
  if (typeof record.at === 'string' && address.test(record.at)) return { value: record.at, columns: ['at'] };
  const file = record.file;
  const line = record.line;
  const col = record.col;
  if (typeof file === 'string' && typeof line === 'number' && typeof col === 'number') return { value: `${file}:${line}:${col}`, columns: ['file', 'line', 'col'] };
  for (const [column, value] of Object.entries(record)) {
    if (typeof value === 'string' && address.test(value)) return { value, columns: [column] };
  }
  return undefined;
}

function renderValue(value: LbugValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(renderValue).join(', ')}]`;
  if (value instanceof Map) return `{${[...value.entries()].map(([key, entry]) => `${renderValue(key)}: ${renderValue(entry)}`).join(', ')}}`;
  return `{${Object.entries(value).map(([key, entry]) => `${key}: ${renderValue(entry)}`).join(', ')}}`;
}

function orderDefault(records: readonly StoreRow[]): StoreRow[] {
  const addressed = records.filter((record) => addressFor(record) !== undefined).sort((left, right) => compareAddresses(addressFor(left)!.value, addressFor(right)!.value));
  const unaddressed = records.filter((record) => addressFor(record) === undefined);
  return [...addressed, ...unaddressed];
}

function compareAddresses(left: string, right: string): number {
  const leftParts = address.exec(left)!;
  const rightParts = address.exec(right)!;
  return leftParts[1]!.localeCompare(rightParts[1]!) || Number(leftParts[2]) - Number(rightParts[2]) || Number(leftParts[3]) - Number(rightParts[3]);
}

function hasTopLevelOrderBy(cypher: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < cypher.length; index++) {
    const character = cypher[index]!;
    if (quote !== undefined) {
      if (character === quote) {
        if (cypher[index + 1] === quote) index++;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') { depth++; continue; }
    if (character === ')' || character === ']' || character === '}') { depth--; continue; }
    if (depth !== 0 || !/[Oo]/.test(character)) continue;
    const candidate = cypher.slice(index, index + 32);
    if (/^order\s+by\b/i.test(candidate) && !/[A-Za-z0-9_]/.test(cypher[index - 1] ?? '')) return true;
  }
  return false;
}

function rejected(field: string, received: string, expected: string, next: string): InvocationError {
  return { category: 'invocation', code: 'query-rejected', problems: [{ field, received, expected, next }] };
}

export default handler;
