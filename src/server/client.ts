import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Completion, Invocation, ToolError } from '../commands/types.js';
import { discoverRoot, pathsForRoot, readState, type ServerPaths } from './lifecycle.js';
import { NdjsonReader, request, type ResponseFrame, type WireFrame, writeFrame } from './wire.js';

export async function invokeResident(invocation: Invocation): Promise<Completion> {
  const root = discoverRoot(invocation.root);
  return send(root, 'invoke', invocation, true);
}

export async function serverStatus(rootOverride?: string): Promise<Completion> {
  const root = discoverRoot(rootOverride);
  const paths = pathsForRoot(root);
  if (!existsSync(paths.port)) return { element: 'server', attributes: { root, state: 'stopped' }, count: 0 };
  return send(root, 'status', undefined, false);
}

export async function serverStop(rootOverride?: string): Promise<Completion> {
  const root = discoverRoot(rootOverride);
  const paths = pathsForRoot(root);
  if (!existsSync(paths.port)) return { element: 'server', attributes: { root, state: 'stopped' }, count: 0 };
  return send(root, 'stop', undefined, false);
}

export async function serverReload(rootOverride?: string): Promise<Completion> {
  const root = discoverRoot(rootOverride);
  await serverStop(root);
  return ensure(root);
}

async function send(root: string, operation: 'invoke' | 'status' | 'stop', invocation: Invocation | undefined, ensureServer: boolean): Promise<Completion> {
  const paths = pathsForRoot(root);
  if (ensureServer) await ensure(root);
  try { return await exchange(paths, request(root, operation, invocation)); }
  catch (error) {
    if (ensureServer) {
      await ensure(root, true);
      try { return await exchange(paths, request(root, operation, invocation)); }
      catch { /* one fresh-session replay falls through to tool failure */ }
    }
    return unavailable(paths, error);
  }
}

async function ensure(root: string, force = false): Promise<Completion> {
  const paths = pathsForRoot(root);
  if (!force && existsSync(paths.port)) {
    try { return await exchange(paths, request(root, 'status')); } catch { /* a lock holder will clean stale endpoint */ }
  }
  spawn(process.execPath, [fileURLToPath(new URL('../../dist/server/main.js', import.meta.url)), '--root', root], { detached: true, stdio: 'ignore' }).unref();
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (existsSync(paths.port)) {
      try { return await exchange(paths, request(root, 'status')); } catch { /* wait for the winning candidate */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return unavailable(paths, 'No resident became ready within 30 seconds.');
}

function exchange(paths: ServerPaths, payload: ReturnType<typeof request>): Promise<Completion> {
  return new Promise((resolve, reject) => {
    const socket = connect(paths.port);
    const reader = new NdjsonReader();
    let settled = false;
    const finish = (completion: Completion) => { if (!settled) { settled = true; socket.end(); resolve(completion); } };
    const timeout = setTimeout(() => { if (!settled) { settled = true; socket.destroy(); reject(new Error('discovery/admission deadline exceeded')); } }, 30_000);
    socket.on('connect', () => writeFrame(socket, payload));
    socket.on('data', (chunk) => {
      for (const value of reader.push(chunk)) {
        const frame = value as WireFrame;
        if (frame.type !== 'response' || frame.requestId !== payload.requestId) continue;
        clearTimeout(timeout);
        const response = frame as ResponseFrame;
        if (response.completion.answer) finish(response.completion.answer);
        else if (response.completion.error) finish(response.completion.error);
        else reject(new Error('invalid terminal response'));
      }
    });
    socket.on('error', reject);
    socket.on('close', () => { if (!settled) reject(new Error('resident closed before responding')); });
  });
}

function unavailable(paths: ServerPaths, error: unknown): ToolError {
  return { category: 'tool', code: 'server-unavailable', message: 'The resident server could not be reached.', logPath: paths.log, received: error instanceof Error ? error.message : String(error), expected: 'a ready resident for this workspace', next: 'Run `symbols server status`; do not delete the lock file.' };
}
