import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { attachReadContext, type ExposureResult } from '../src/context-exposure.js';
import { renderCompletion } from '../src/output.js';
import { parseInvocation } from '../src/commands/tree.js';
import type { Answer, Invocation } from '../src/commands/types.js';

const cwd = path.resolve('test/fixture');

function invocation(args: string[]): Invocation {
  const parsed = parseInvocation(args, cwd);
  assert.ok(!('category' in parsed) && !('help' in parsed));
  return parsed;
}

function answer(displayedFiles: string[]): Answer {
  return { data: { element: 'result' }, count: 1, displayedFiles, receipt: '1 answer, 0 ms' };
}

function result(stdout: string, exitCode = 0): ExposureResult { return { exitCode, stdout, stderr: '' }; }

test('show, type, and outline expose only their displayed declaration files once', async () => {
  const files = [path.resolve('/tmp/first.ts'), path.resolve('/tmp/second.ts')];
  for (const args of [['show', 'first'], ['type', 'first'], ['outline', 'first.ts']]) {
    let received: readonly string[] | undefined;
    const attached = await attachReadContext(invocation(args), answer([files[0]!, files[1]!, files[0]!]), async (paths, receivedCwd) => {
      received = paths;
      assert.equal(receivedCwd, cwd);
      return result('{"content":"<auto-loaded-context>\\ncontext\\n</auto-loaded-context>"}');
    }, 'node');
    assert.deepEqual(received, files, args.join(' '));
    const rendered = renderCompletion(attached, false);
    assert.match(rendered.stdout, /^<auto-loaded-context>/);
    assert.match(rendered.stdout, /<result\/>/);
  }
});

test('context expose failures leave the completed tsym result and exit status unchanged', async () => {
  const completed = answer(['/tmp/first.ts']);
  const failed = await attachReadContext(invocation(['show', 'first']), completed, async () => result('{"error":"context_delivery_failed","message":"unknown node"}', 1), 'node');
  const rendered = renderCompletion(failed, false);
  assert.equal(rendered.exitCode, 0);
  assert.doesNotMatch(rendered.stdout, /context_delivery_failed/);
  assert.match(rendered.stdout, /<result\/>/);
  assert.match(rendered.stderr, /context_delivery_failed/);

  const malformed = await attachReadContext(invocation(['show', 'first']), completed, async () => result('not json'), 'node');
  const malformedRendered = renderCompletion(malformed, false);
  assert.equal(malformedRendered.exitCode, 0);
  assert.doesNotMatch(malformedRendered.stdout, /not json/);
  assert.match(malformedRendered.stderr, /context-expose-invalid-response/);
});

test('context expose is skipped outside a node, for JSON, empty results, and other leaves', async () => {
  const cases: Array<[Invocation, Answer, string | undefined]> = [
    [invocation(['show', 'first']), answer(['/tmp/first.ts']), ''], 
    [invocation(['show', 'first', '--json']), answer(['/tmp/first.ts']), 'node'],
    [invocation(['show', 'first']), { ...answer(['/tmp/first.ts']), count: 0 }, 'node'],
    [invocation(['find', 'first']), answer(['/tmp/first.ts']), 'node'],
  ];
  for (const [call, completed, nodeId] of cases) {
    let calls = 0;
    const attached = await attachReadContext(call, completed, async () => {
      calls++;
      return result('{"content":"context"}');
    }, nodeId);
    assert.equal(calls, 0);
    assert.equal(renderCompletion(attached, false).stdout, '<result/>\n');
  }
});

test('tsym JSON omits wire-only displayed files and context', async () => {
  const attached = await attachReadContext(invocation(['type', 'first']), answer(['/tmp/first.ts']), async () => result('{"content":"context"}'), 'node');
  const rendered = renderCompletion(attached, true);
  assert.doesNotMatch(rendered.stdout, /displayedFiles|context/);
  assert.deepEqual(JSON.parse(rendered.stdout), { data: { element: 'result' }, count: 1, receipt: '1 answer, 0 ms' });
});
