import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { attachReadContext } from '../context-exposure.js';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Completion, Invocation, ToolError } from '../commands/types.js';
import { readMetadata } from '../store/meta.js';
import { discoverRoot, ensureStateDirectory, maxResidents, pathsForRoot, readState, removeEndpoint, type PublishedState, type ServerPaths } from './lifecycle.js';
import { NdjsonReader, request, type PhaseFrame, type ResponseFrame, type WireFrame, writeFrame } from './wire.js';

type DeadlinePhase = 'queued' | 'project-load' | 'index-build' | 'running';

class SessionDied extends Error {}
class Stopping extends Error {}
class DeadlineExpired extends Error {
  constructor(readonly phase: DeadlinePhase | undefined, readonly command: string | undefined) { super(`${phase ?? 'admission'} deadline exceeded`); }
}

export async function invokeResident(invocation: Invocation): Promise<Completion> {
  const root = discoverRoot(invocation.root);
  return attachReadContext(invocation, await send(root, 'invoke', invocation, true));
}

export async function serverStatus(rootOverride?: string): Promise<Completion> {
  const root = discoverRoot(rootOverride);
  const paths = pathsForRoot(root);
  if (!existsSync(paths.port)) return { data: { element: 'server', attributes: { root, state: 'stopped' } }, count: 0 };
  return send(root, 'status', undefined, false);
}

export async function serverStop(rootOverride?: string): Promise<Completion> {
  const root = discoverRoot(rootOverride);
  const paths = pathsForRoot(root);
  if (!existsSync(paths.port)) return { data: { element: 'server', attributes: { root, state: 'stopped' } }, count: 0 };
  return send(root, 'stop', undefined, false);
}

export async function serverReload(rootOverride?: string): Promise<Completion> {
  const root = discoverRoot(rootOverride);
  await serverStop(root);
  const completion = await ensure(root, true, true);
  return withStartup(completion, completion.startupStartedAt);
}

async function send(root: string, operation: 'invoke' | 'status' | 'stop', invocation: Invocation | undefined, ensureServer: boolean): Promise<Completion> {
  const paths = pathsForRoot(root);
  if (ensureServer) {
    const ensured = await ensure(root);
    if ('category' in ensured) return ensured;
    try {
      return withStartup(await exchange(paths, request(root, operation, invocation)), ensured.startupStartedAt);
    } catch (error) {
      if (error instanceof DeadlineExpired) return deadlineFailure(paths, error);
      if (error instanceof Stopping) return stoppingFailure(paths);
      if (!(error instanceof SessionDied)) return unavailable(paths, error);
    }
  } else {
    try {
      return await exchange(paths, request(root, operation, invocation));
    } catch (error) {
      if (error instanceof DeadlineExpired) return deadlineFailure(paths, error);
      if (error instanceof Stopping) return stoppingFailure(paths);
      return unavailable(paths, error);
    }
  }

  const ensured = await ensure(root, true);
  if ('category' in ensured) return ensured;
  try {
    return withStartup(await exchange(paths, request(root, operation, invocation)), ensured.startupStartedAt);
  } catch (error) {
    if (error instanceof DeadlineExpired) return deadlineFailure(paths, error);
    if (error instanceof Stopping) return stoppingFailure(paths);
    if (error instanceof SessionDied) return { category: 'tool', code: 'server-died', message: 'The resident server died again before completing the request.', logPath: paths.log, next: 'Read the server log and repair the workspace before retrying.' };
    return unavailable(paths, error);
  }
}

async function ensure(root: string, force = false, rebuild = false): Promise<Completion & { startupStartedAt?: number }> {
  const paths = pathsForRoot(root);
  if (!force && existsSync(paths.port)) {
    try { return await exchange(paths, request(root, 'status')); } catch { /* a lock holder will clean stale endpoint */ }
  }
  await makeResidentSlot(paths);
  const startedAt = performance.now();
  ensureStateDirectory(paths);
  const log = openSync(paths.log, 'a', 0o600);
  // A cold start on a large root takes tens of seconds; say so, so a caller with a short tool timeout can tell waiting from hung.
  const lastIndexMs = readMetadata(paths.store)?.indexDurationMs;
  process.stderr.write(`tsym: starting a resident for ${root}${lastIndexMs ? `; the last index took ${Math.round(lastIndexMs / 1000)} s, so expect that long` : ''}. Later calls answer in milliseconds.\n`);
  let childExit: string | undefined;
  try {
    const child = spawn(process.execPath, ['--max-old-space-size=3072', fileURLToPath(new URL('../../dist/server/main.js', import.meta.url)), '--root', root, ...(rebuild ? ['--rebuild'] : [])], { detached: true, stdio: ['ignore', log, log] });
    // Exit code 0 means this candidate lost the lock to another resident, which we keep waiting for; anything else means no resident is coming from this spawn.
    child.once('exit', (code, signal) => { if (code !== 0) childExit = signal ? `killed by ${signal}` : `exited with code ${code}`; });
    child.once('error', (error) => { childExit = `failed to start: ${error.message}`; });
    child.unref();
  } finally { closeSync(log); }
  const deadline = startedAt + 30_000;
  while (performance.now() < deadline) {
    if (existsSync(paths.port)) {
      try { return { ...await exchange(paths, request(root, 'status')), startupStartedAt: startedAt }; } catch { /* wait for the winning candidate */ }
    }
    if (childExit !== undefined) return startupDied(paths, childExit);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return unavailable(paths, 'No resident became ready within 30 seconds.');
}

function startupDied(paths: ServerPaths, how: string): ToolError {
  let tail = '';
  try { tail = readFileSync(paths.log, 'utf8').trimEnd().split('\n').slice(-3).join(' | '); } catch { /* the log may not exist yet */ }
  return { category: 'tool', code: 'server-died', message: `The resident process ${how} before it became ready.`, logPath: paths.log, received: tail || 'an empty log', next: 'Read the server log; if it reports out of memory, pass --root with a smaller repository or package directory.' };
}

interface Resident {
  state: PublishedState;
}

/** Frees a slot by stopping the least recently used resident of any root. Never fails the caller: a resident that will not stop is killed, and one that cannot be killed is left running over the cap. */
async function makeResidentSlot(paths: ServerPaths): Promise<void> {
  const cap = maxResidents();
  let residents = liveResidents(paths);
  while (residents.length >= cap) {
    const candidate = residents.sort((left, right) => Date.parse(left.state.idleDeadline) - Date.parse(right.state.idleDeadline))[0]!;
    if (!await evict(candidate.state)) return;
    residents = liveResidents(paths);
  }
}

async function evict(state: PublishedState): Promise<boolean> {
  const victim = pathsForRoot(state.root);
  // A graceful stop waits as long as the resident's own request deadlines allow, as serverStop did.
  if (existsSync(victim.port)) {
    await exchange(victim, request(state.root, 'stop')).catch(() => undefined);
    if (await exited(state.pid, 5_000)) return true;
  }
  // Only a process that is verifiably this tsym resident may be signalled; a stale state file can name a reused pid.
  if (!isResidentProcess(state)) { removeEndpoint(victim); return true; }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try { process.kill(state.pid, signal); } catch { /* already gone */ }
    if (await exited(state.pid, 2_000)) { removeEndpoint(victim); return true; }
  }
  return false;
}

function isResidentProcess(state: PublishedState): boolean {
  try {
    const command = execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' });
    return command.includes('server/main.js') && command.includes(state.root);
  } catch { return false; }
}

async function exited(pid: number, withinMs: number): Promise<boolean> {
  const deadline = performance.now() + withinMs;
  while (processExists(pid)) {
    if (performance.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function liveResidents(paths: ServerPaths): Resident[] {
  const base = path.dirname(paths.state);
  try {
    return readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const residentPaths = { ...paths, state: path.join(base, entry.name), pid: path.join(base, entry.name, 'pid') };
      const state = readState(residentPaths);
      if (!state) return [];
      if (processExists(state.pid)) return [{ state }];
      rmSync(residentPaths.pid, { force: true });
      return [];
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function exchange(paths: ServerPaths, payload: ReturnType<typeof request>): Promise<Completion> {
  return new Promise((resolve, reject) => {
    const socket = connect(paths.port);
    const reader = new NdjsonReader();
    let settled = false;
    let stopping = false;
    let deadlinePhase: DeadlinePhase | undefined;
    let command: string | undefined;
    const finish = (completion: Completion) => { if (!settled) { settled = true; clearTimeout(timeout); socket.end(); resolve(completion); } };
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timeout); socket.destroy(); reject(error); } };
    let timeout = arm(30_000);
    const rearm = (remainingMs: number | undefined) => {
      if (remainingMs === undefined) return;
      clearTimeout(timeout);
      timeout = arm(remainingMs);
    };
    function arm(delay: number): NodeJS.Timeout { return setTimeout(() => fail(new DeadlineExpired(deadlinePhase, command)), delay); }
    const phase = (frame: PhaseFrame) => {
      switch (frame.phase) {
        case 'queued': deadlinePhase = 'queued'; break;
        case 'project-load-start':
        case 'project-load-end': deadlinePhase = 'project-load'; break;
        case 'index-build-start':
        case 'index-build-end': deadlinePhase = 'index-build'; break;
        case 'running': deadlinePhase = 'running'; break;
        case 'command-start': command = frame.command; break;
        case 'stopping': stopping = true; break;
        case 'accepted': break;
      }
      rearm(frame.remainingMs);
    };
    socket.on('connect', () => writeFrame(socket, payload));
    socket.on('data', (chunk) => {
      for (const value of reader.push(chunk)) {
        const frame = value as WireFrame;
        if (frame.requestId !== payload.requestId) continue;
        if (frame.type === 'phase') { phase(frame); continue; }
        if (frame.type !== 'response') continue;
        const response = frame as ResponseFrame;
        if (response.completion.answer) finish(response.completion.answer);
        else if (response.completion.error) finish(response.completion.error);
        else fail(new Error('invalid terminal response'));
      }
    });
    socket.on('error', (error) => fail(stopping ? new Stopping(error.message) : new SessionDied(error.message)));
    socket.on('close', () => { if (!settled) fail(stopping ? new Stopping('resident stopped before responding') : new SessionDied('resident closed before responding')); });
  });
}

function withStartup(completion: Completion & { startupStartedAt?: number }, startupStartedAt: number | undefined): Completion & { startupMs?: number } {
  if (startupStartedAt === undefined || 'category' in completion) return completion;
  const { startupStartedAt: _, ...answer } = completion;
  return { ...answer, startupMs: Math.round(performance.now() - startupStartedAt) };
}

function deadlineFailure(paths: ServerPaths, deadline: DeadlineExpired): ToolError {
  if (deadline.phase === 'project-load') return { category: 'tool', code: 'project-load-timeout', message: 'TypeScript did not load the workspace project before its deadline.', logPath: paths.log, next: 'Repair the project, then retry.' };
  if (deadline.phase === 'index-build') return { category: 'tool', code: 'index-build-timeout', message: 'The workspace index did not build before its deadline.', logPath: paths.log, next: 'Repair the project, then retry.' };
  if (deadline.phase === 'running') return { category: 'tool', code: 'request-timeout', message: 'The semantic request exceeded its deadline.', logPath: paths.log, received: deadline.command ?? 'no semantic operation started', next: 'Retry after repairing the workspace or narrowing the command.' };
  return { category: 'tool', code: 'server-unavailable', message: 'The resident did not begin this request before its admission deadline.', logPath: paths.log, next: 'Retry after the current request completes.' };
}

function stoppingFailure(paths: ServerPaths): ToolError {
  return { category: 'tool', code: 'server-unavailable', message: 'The resident stopped before completing the request.', logPath: paths.log, next: 'Wait for stop to complete before invoking tsym.' };
}

function unavailable(paths: ServerPaths, error: unknown): ToolError {
  return { category: 'tool', code: 'server-unavailable', message: 'The resident server could not be reached.', logPath: paths.log, received: error instanceof Error ? error.message : String(error), expected: 'a ready resident for this workspace', next: 'Run `tsym server status`; do not delete the lock file.' };
}
