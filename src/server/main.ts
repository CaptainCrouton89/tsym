import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Socket } from 'node:net';
import { appendFileSync, chmodSync, openSync, readdirSync } from 'node:fs';
import { discoverRoot, ensureStateDirectory, idleSeconds, pathsForRoot, publishState, removeEndpoint, type ServerPaths } from './lifecycle.js';
import { NdjsonReader, WIRE_VERSION, type WireFrame, type WireRequest, writeFrame } from './wire.js';
import { createSemanticContext } from './context.js';
import { bundledTypeScriptVersion, Ts7ServerDiedError, TypeScriptBinaryError } from '../ts7/api.js';
import { buildIndex, reuseIndex } from '../index/build.js';
import { ingestCommits } from '../index/commits.js';
import { refreshIndex } from '../index/refresh.js';
import { IndexStateController } from '../index/state.js';
import { watchIndex, type IndexWatcher, type WatchBatch } from '../index/watch.js';
import { canReuse, hasSourceDrift, metadataFor, readMetadata, writeMetadata } from '../store/meta.js';
import { EngineBinaryError, Store } from '../store/store.js';
import { executeSemantic } from '../commands/handlers.js';
import { findNode } from '../commands/tree.js';
import type { Completion, ToolError } from '../commands/types.js';

interface Queued {
  request: WireRequest;
  socket: Socket;
  remainingQueueMs: number;
  queueStartedAt?: number;
  queueTimer?: NodeJS.Timeout;
}

class DeadlineExceeded extends Error {
  constructor(readonly phase: 'project-load' | 'request') { super(`${phase} deadline exceeded`); }
}

async function main(): Promise<void> {
  const root = discoverRoot(arg('--root'));
  const paths = pathsForRoot(root);
  ensureStateDirectory(paths);
  const logFd = openSync(paths.log, 'a', 0o600);
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(paths.lock);
    database.exec('BEGIN EXCLUSIVE');
  } catch (error: unknown) {
    if (isBusy(error)) process.exit(0);
    append(paths, `lock failure: ${safe(error)}`);
    process.exit(1);
  }

  const forceRebuild = process.argv.includes('--rebuild');
  let semantic: ReturnType<typeof createSemanticContext> | undefined;
  let store: Store | undefined;
  let index: IndexStateController | undefined;
  let watcher: IndexWatcher | undefined;
  const bootedAt = new Date();
  const bootedAtMonotonic = performance.now();
  let bootstrapped = false;
  let loading = false;
  let stopping = false;
  let retired = false;
  let active: Queued | undefined;
  let queue: Queued[] = [];
  let currentCommand: string | undefined;
  let loadDeadlineAt: number | undefined;
  let activeDeadlineAt: number | undefined;
  let activeTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let listenerClosing = false;
  const sockets = new Set<Socket>();
  const invokeSockets = new Map<Socket, string>();
  const stopRequests: { requestId: string; socket: Socket }[] = [];
  const closeProgram = () => {
    try { semantic?.program.close(); }
    catch (error) { append(paths, `TypeScript 7 shutdown failure: ${safe(error)}`); }
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    const reader = new NdjsonReader();
    socket.on('data', (chunk) => {
      for (const value of reader.push(chunk)) void receive(value, socket);
    });
    socket.on('close', () => {
      sockets.delete(socket);
      invokeSockets.delete(socket);
      const queued = queue.find((item) => item.socket === socket);
      if (queued) removeQueued(queued);
    });
    socket.on('error', () => {});
  });

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!active && queue.length === 0) retire();
    }, idleSeconds() * 1000);
    idleTimer.unref();
  };

  const remaining = (deadlineAt: number | undefined) => Math.max(0, Math.ceil((deadlineAt ?? performance.now()) - performance.now()));
  const sendPhase = (socket: Socket, requestId: string, phase: Extract<WireFrame, { type: 'phase' }>['phase'], remainingMs?: number, command?: string) => {
    if (!socket.destroyed) send(socket, { type: 'phase', requestId, phase, remainingMs, command });
  };
  const toolError = (code: string, message: string, next: string): ToolError => ({ category: 'tool', code, message, logPath: paths.log, next });
  const respond = (socket: Socket, requestId: string, completion: Completion) => {
    if (!socket.destroyed) send(socket, { type: 'response', requestId, completion: 'category' in completion ? { error: completion } : { answer: completion } });
  };
  const finishSocket = (socket: Socket) => { if (!socket.destroyed) socket.end(); };

  const removeQueued = (queued: Queued) => {
    if (queued.queueTimer) clearTimeout(queued.queueTimer);
    queue = queue.filter((item) => item !== queued);
  };
  const pauseQueueDeadline = (queued: Queued) => {
    if (queued.queueTimer) clearTimeout(queued.queueTimer);
    queued.queueTimer = undefined;
    if (queued.queueStartedAt !== undefined) queued.remainingQueueMs = Math.max(0, queued.remainingQueueMs - (performance.now() - queued.queueStartedAt));
    queued.queueStartedAt = undefined;
  };
  const queueTimeout = (queued: Queued) => {
    if (retired || loading || !queue.includes(queued)) return;
    removeQueued(queued);
    respond(queued.socket, queued.request.requestId, toolError('server-unavailable', 'The resident did not begin this request within its admission deadline.', 'Retry after the current request completes.'));
    finishSocket(queued.socket);
    void processQueue();
  };
  const armQueueDeadline = (queued: Queued) => {
    if (retired || loading || !queue.includes(queued)) return;
    queued.queueStartedAt = performance.now();
    queued.queueTimer = setTimeout(() => queueTimeout(queued), queued.remainingQueueMs);
    queued.queueTimer.unref();
    sendPhase(queued.socket, queued.request.requestId, 'queued', queued.remainingQueueMs);
  };
  const failQueued = (queued: Queued, completion: ReturnType<typeof toolError>) => {
    removeQueued(queued);
    respond(queued.socket, queued.request.requestId, completion);
    finishSocket(queued.socket);
  };

  const exitAfterCleanup = () => {
    if (listenerClosing) return;
    listenerClosing = true;
    server.close(() => process.exit(0));
  };
  const finishRetirement = async (preserve: ReadonlySet<Socket>) => {
    watcher?.close();
    closeProgram();
    store?.close();
    removeEndpoint(paths);
    try { database.close(); } catch {}
    for (const socket of sockets) if (!preserve.has(socket)) socket.destroy();
    exitAfterCleanup();
  };
  const retire = (preserve = new Set<Socket>()) => {
    if (retired) return;
    retired = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (activeTimer) clearTimeout(activeTimer);
    for (const queued of queue) if (queued.queueTimer) clearTimeout(queued.queueTimer);
    queue = [];
    void finishRetirement(preserve);
  };

  const completeStop = () => {
    if (retired || !stopping || active) return;
    retired = true;
    void finishStop();
  };
  const finishStop = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    watcher?.close();
    closeProgram();
    store?.close();
    removeEndpoint(paths);
    try { database.close(); } catch {}
    for (const stop of stopRequests) {
      respond(stop.socket, stop.requestId, { data: { element: 'server', attributes: { root, state: 'stopping' } }, count: 1 });
      finishSocket(stop.socket);
    }
    for (const socket of sockets) if (!stopRequests.some((stop) => stop.socket === socket)) socket.destroy();
    exitAfterCleanup();
  };

  const projectLoadTimeout = () => {
    if (retired) return;
    const completion = toolError('project-load-timeout', 'TypeScript did not load the workspace project before its deadline.', 'Repair the project, then retry.');
    if (active) {
      respond(active.socket, active.request.requestId, completion);
      finishSocket(active.socket);
    }
    const preserving = new Set<Socket>([...queue.map((queued) => queued.socket), ...(active ? [active.socket] : [])]);
    for (const queued of queue) failQueued(queued, completion);
    retire(preserving);
  };
  const requestTimeout = () => {
    if (retired || !active) return;
    const detail = currentCommand ?? 'no semantic operation started';
    respond(active.socket, active.request.requestId, { ...toolError('request-timeout', 'The semantic request exceeded its deadline.', 'Retry after repairing the workspace or narrowing the command.'), received: detail });
    finishSocket(active.socket);
    retire(new Set([active.socket]));
  };
  const armActiveDeadline = () => {
    activeDeadlineAt = performance.now() + 120_000;
    activeTimer = setTimeout(requestTimeout, 120_000);
    activeTimer.unref();
    if (active) sendPhase(active.socket, active.request.requestId, 'running', 120_000);
  };

  const loadProjects = async () => {
    loading = true;
    loadDeadlineAt = performance.now() + 60_000;
    if (active) sendPhase(active.socket, active.request.requestId, 'project-load-start', 60_000);
    for (const queued of queue) {
      pauseQueueDeadline(queued);
      sendPhase(queued.socket, queued.request.requestId, 'project-load-start', 60_000);
    }
    let timedOut = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          semantic ??= createSemanticContext(root);
          const { program, projects } = semantic;
          await projects.bootstrap();
          store = new Store(paths.store);
          if (active) sendPhase(active.socket, active.request.requestId, 'index-build-start', remaining(loadDeadlineAt));
          // The watcher starts before the build, not after it: buildIndex takes tens of seconds on a large workspace,
          // and an edit landing in that window would otherwise never be recorded, publishing a stale index as current.
          // buildIndex is synchronous, so no watch callback can run until index is assigned below.
          watcher = watchIndex(root, projects.configured(), refresh, (error) => append(paths, `index refresh failure: ${safe(error)}`), (flush) => index?.markStale(flush));
          const configured = projects.configured();
          const expected = metadataFor(root, configured, headCommit(root));
          const metadata = readMetadata(store.path);
          let built: ReturnType<typeof buildIndex>;
          if (!forceRebuild && canReuse(metadata, expected)) {
            const reused = reuseIndex(store);
            built = hasSourceDrift(metadata!, expected)
              ? refreshIndex(root, program, configured, store, reused, { fileChanges: { invalidateAll: true } }).built
              : reused;
          } else {
            built = buildIndex(root, program, configured, store);
          }
          index = new IndexStateController({ indexedAt: indexedAt(root), state: 'current', built }, (snapshot) => { semantic!.index = snapshot; });
          semantic!.store = store;
          if (active) sendPhase(active.socket, active.request.requestId, 'index-build-end', remaining(loadDeadlineAt));
        })(),
        new Promise<never>((_, reject) => { deadlineTimer = setTimeout(() => { timedOut = true; reject(new DeadlineExceeded('project-load')); }, 60_000); deadlineTimer.unref(); }),
      ]);
      bootstrapped = true;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      loading = false;
      loadDeadlineAt = undefined;
      if (!timedOut && !retired) {
        if (active) sendPhase(active.socket, active.request.requestId, 'project-load-end', 60_000);
        for (const queued of queue) {
          sendPhase(queued.socket, queued.request.requestId, 'project-load-end', 60_000);
          armQueueDeadline(queued);
        }
      }
    }
  };

  const processQueue = async (): Promise<void> => {
    if (active || retired) return;
    if (stopping) { completeStop(); return; }
    const queued = queue.shift();
    if (!queued) { touch(); return; }
    if (queued.queueTimer) clearTimeout(queued.queueTimer);
    if (queued.socket.destroyed) { void processQueue(); return; }
    active = queued;
    currentCommand = undefined;
    sendPhase(queued.socket, queued.request.requestId, 'running', 120_000);
    try {
      if (!bootstrapped) await loadProjects();
      if (retired) return;
      armActiveDeadline();
      const requestInvocation = queued.request.invocation;
      if (!requestInvocation) throw new Error('invoke request omitted its invocation');
      currentCommand = requestInvocation.path.join(' ');
      const declaration = findNode(requestInvocation.path).node;
      if (readsIndex(declaration.handler)) await index?.wait();
      const completion = await executeSemantic(semantic!, { root, cwd: requestInvocation.cwd, json: false, path: requestInvocation.path, declaration, input: { args: requestInvocation.args, flags: requestInvocation.flags, explicit: new Set(requestInvocation.explicit) } });
      if ('category' in completion && completion.category === 'tool' && !completion.logPath) completion.logPath = paths.log;
      if (!retired) respond(queued.socket, queued.request.requestId, completion);
    } catch (error) {
      if (error instanceof DeadlineExceeded && error.phase === 'project-load') {
        projectLoadTimeout();
        return;
      }
      if (error instanceof Ts7ServerDiedError) {
        if (!retired) respond(queued.socket, queued.request.requestId, toolError('server-died', 'The bundled TypeScript 7 process stopped responding after one recovery attempt.', 'Retry to start a fresh resident.'));
        return;
      }
      if (error instanceof EngineBinaryError || error instanceof TypeScriptBinaryError) {
        if (!retired) respond(queued.socket, queued.request.requestId, { category: 'tool', code: error.code, attributes: { platform: error.platform }, message: error.message });
        return;
      }
      if (!retired) respond(queued.socket, queued.request.requestId, toolError('project-load-failed', 'TypeScript could not load the workspace project.', error instanceof Error ? error.message : 'Read the log and repair the project.'));
    } finally {
      if (activeTimer) clearTimeout(activeTimer);
      activeTimer = undefined;
      activeDeadlineAt = undefined;
      if (active === queued) active = undefined;
      if (!retired) {
        if (stopping) completeStop();
        else void processQueue();
      }
    }
  };

  const refresh = async (batch: WatchBatch): Promise<void> => {
    if (!store || !index) throw new Error('The index refresh ran before startup completed.');
    await index.rebuild(async () => {
      if (!semantic) throw new Error('The index refresh ran before TypeScript initialized.');
      const configured = semantic.projects.configured();
      const refreshed = refreshIndex(root, semantic.program, configured, store!, index!.current().built, {
        fileChanges: batch.fileChanges,
        full: batch.full,
        validate: process.env.TSYM_VALIDATE_INDEX === '1',
      });
      if (batch.git) {
        const commit = headCommit(root);
        ingestCommits(root, store!, [commit]);
        writeMetadata(store!.path, metadataFor(root, configured, commit, refreshed.built.receipt.durationMs));
      }
      return { indexedAt: indexedAt(root), state: 'current', built: refreshed.built };
    });
    if (batch.full) watcher?.refresh();
  };

  const receive = async (value: unknown, socket: Socket): Promise<void> => {
    const request = value as Partial<WireRequest>;
    if (request.version !== WIRE_VERSION || request.root !== root || typeof request.requestId !== 'string' || !request.operation) {
      respond(socket, typeof request.requestId === 'string' ? request.requestId : '', toolError('server-unavailable', 'The resident received an invalid wire request.', 'Retry with the installed tsym CLI.'));
      finishSocket(socket);
      return;
    }
    if (retired) {
      respond(socket, request.requestId, toolError('server-unavailable', 'The resident is retiring.', 'Wait for the next resident before retrying.'));
      finishSocket(socket);
      return;
    }
    if (request.operation === 'status' && forceRebuild && !bootstrapped) {
      try { await loadProjects(); }
      catch (error) {
        if (error instanceof EngineBinaryError || error instanceof TypeScriptBinaryError) respond(socket, request.requestId, { category: 'tool', code: error.code, attributes: { platform: error.platform }, message: error.message });
        else respond(socket, request.requestId, toolError('project-load-failed', 'TypeScript could not load the workspace project.', error instanceof Error ? error.message : 'Read the log and repair the project.'));
        finishSocket(socket);
        return;
      }
    }
    if (request.operation === 'status') {
      let memory: number;
      try { memory = residentMemory(semantic?.program.pid); }
      catch (error) {
        respond(socket, request.requestId, toolError('server-unavailable', 'The resident could not measure its process memory.', error instanceof Error ? error.message : 'Read the server log.'));
        finishSocket(socket);
        return;
      }
      const state = stopping ? 'stopping' : 'ready';
      const snapshot = index?.current();
      const receipt = snapshot?.built.receipt;
      const indexedCommit = readMetadata(paths.store)?.indexedCommit;
      respond(socket, request.requestId, { data: { element: 'server', attributes: { root, state, pid: process.pid, port: paths.port, log: paths.log, idle: `${idleSeconds()}s`, uptime: `${Math.floor(performance.now() - bootedAtMonotonic)}ms`, memory, typescript: semantic ? bundledTypeScriptVersion() : undefined, store: paths.store, indexedCommit, declarations: receipt?.declarations, edges: receipt ? Object.values(receipt.relationships).reduce((total, count) => total + count, 0) : undefined, notInProgram: semantic ? unconfiguredFileCount(root, semantic.projects.records()) : undefined, index: snapshot?.state, indexDuration: receipt ? `${Math.round(receipt.durationMs)}ms` : undefined } }, count: 1 });
      return;
    }
    if (request.operation === 'stop') {
      stopRequests.push({ requestId: request.requestId, socket });
      if (!stopping) {
        stopping = true;
        if (idleTimer) clearTimeout(idleTimer);
        publishState(paths, { root, pid: process.pid, bootedAt: bootedAt.toISOString(), port: paths.port, log: paths.log, idleDeadline: new Date().toISOString(), state: 'stopping' });
        for (const [invokeSocket, requestId] of invokeSockets) {
          const deadlineAt = active?.socket === invokeSocket ? (loading ? loadDeadlineAt : activeDeadlineAt) : undefined;
          sendPhase(invokeSocket, requestId, 'stopping', deadlineAt === undefined ? undefined : remaining(deadlineAt));
        }
        const completion = toolError('server-unavailable', 'The resident is stopping.', 'Wait for stop to complete before invoking tsym.');
        for (const queued of [...queue]) failQueued(queued, completion);
      }
      completeStop();
      return;
    }
    if (stopping) {
      respond(socket, request.requestId, toolError('server-unavailable', 'The resident is stopping.', 'Wait for stop to complete before invoking tsym.'));
      finishSocket(socket);
      return;
    }
    touch();
    invokeSockets.set(socket, request.requestId);
    const queued: Queued = { request: request as WireRequest, socket, remainingQueueMs: 30_000 };
    sendPhase(socket, queued.request.requestId, 'accepted', 30_000);
    queue.push(queued);
    if (loading) {
      sendPhase(socket, queued.request.requestId, 'queued', queued.remainingQueueMs);
      sendPhase(socket, queued.request.requestId, 'project-load-start', remaining(loadDeadlineAt));
    } else armQueueDeadline(queued);
    void processQueue();
  };

  removeEndpoint(paths);
  server.listen(paths.port, () => {
    chmodSync(paths.port, 0o600);
    publishState(paths, { root, pid: process.pid, bootedAt: bootedAt.toISOString(), port: paths.port, log: paths.log, idleDeadline: new Date(Date.now() + idleSeconds() * 1000).toISOString(), state: 'ready' });
    append(paths, `ready pid=${process.pid} root=${root}`);
    touch();
  });
  server.on('error', (error) => { append(paths, `socket failure: ${safe(error)}`); retire(); });
  process.on('SIGTERM', retire);
  process.on('SIGINT', retire);
  void logFd;
}

function send(socket: Socket, frame: WireFrame): void { writeFrame(socket, frame); }
function arg(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function isBusy(error: unknown): boolean { return (error as { code?: string; errcode?: number }).code === 'ERR_SQLITE_ERROR' && (error as { errcode?: number }).errcode === 5 || String(error).includes('database is locked'); }
function append(paths: ServerPaths, message: string): void { appendFileSync(paths.log, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }); }
function safe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function readsIndex(handler: string | undefined): boolean {
  return handler === 'outline' || handler === 'find' || handler === 'show' || handler === 'inspect' || handler === 'query';
}

function indexedAt(root: string): string {
  return `${headCommit(root).slice(0, 7)} ${new Date().toISOString()}`;
}

function headCommit(root: string): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unknown'; }
}

function residentMemory(tsgoPid: number | undefined): number {
  const pids = tsgoPid === undefined ? [process.pid] : [process.pid, tsgoPid];
  const rss = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number);
  if (rss.length !== pids.length || rss.some((value) => !Number.isFinite(value))) throw new Error('ps did not report every resident process');
  return rss.reduce((total, value) => total + value, 0) * 1024;
}

function unconfiguredFileCount(root: string, records: readonly { files: ReadonlySet<string> }[]): number {
  const configured = new Set(records.flatMap((record) => [...record.files]));
  const extensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
  const skipped = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
  let count = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { if (!skipped.has(entry.name)) visit(file); }
      else if (entry.isFile() && extensions.has(file.slice(file.lastIndexOf('.'))) && !configured.has(file)) count++;
    }
  };
  visit(root);
  return count;
}

void main();
