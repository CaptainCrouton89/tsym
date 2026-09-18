import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Answer, Completion, Invocation } from './commands/types.js';

export interface ExposureResult { exitCode: number | null; stdout: string; stderr: string; error?: string; }
export type ExposureRunner = (files: readonly string[], cwd: string) => Promise<ExposureResult>;

export async function attachReadContext(invocation: Invocation, completion: Completion, run: ExposureRunner = runContextExpose, nodeId = process.env.CRTR_NODE_ID): Promise<Completion> {
  if (!nodeId?.trim() || invocation.json || !isReadLeaf(invocation) || !isAnswer(completion) || completion.count === 0) return completion;
  const files = [...new Set((completion.displayedFiles ?? []).map((file) => path.resolve(file)))];
  if (files.length === 0) return completion;

  try {
    const result = await run(files, invocation.cwd);
    if (result.exitCode !== 0) return withContextError(completion, deliveryError(result, 'context-expose-failed'));
    const response = jsonObject(result.stdout);
    if (!response) return withContextError(completion, structuredError('context-expose-invalid-response', result.stderr || 'crtr sys context expose returned invalid JSON.'));
    if (response.content === undefined) return completion;
    if (typeof response.content !== 'string') return withContextError(completion, structuredError('context-expose-invalid-response', 'crtr sys context expose returned a non-string content field.'));
    return { ...completion, context: response.content };
  } catch (error) {
    return withContextError(completion, structuredError('context-expose-failed', error instanceof Error ? error.message : String(error)));
  }
}

function isReadLeaf(invocation: Invocation): boolean { return invocation.declaration.handler === 'show' || invocation.declaration.handler === 'type' || invocation.declaration.handler === 'outline'; }
function isAnswer(completion: Completion): completion is Answer { return !('category' in completion); }
function withContextError(completion: Answer, contextError: string): Answer { return { ...completion, contextError }; }

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function deliveryError(result: ExposureResult, code: string): string {
  const response = jsonObject(result.stdout);
  if (response) return JSON.stringify(response);
  return structuredError(code, result.stderr || result.error || 'crtr sys context expose failed.');
}

function structuredError(error: string, message: string): string { return JSON.stringify({ error, message }); }

async function runContextExpose(files: readonly string[], cwd: string): Promise<ExposureResult> {
  return new Promise((resolve) => {
    const child = spawn('crtr', ['sys', 'context', 'expose', '--json', ...files.flatMap((file) => ['--file', file])], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.once('error', (error) => resolve({ exitCode: null, stdout, stderr, error: error.message }));
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
