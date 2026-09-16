import { DatabaseSync } from 'node:sqlite';
import { createServer, type Socket } from 'node:net';
import { appendFileSync, chmodSync, openSync } from 'node:fs';
import { discoverRoot, ensureStateDirectory, idleSeconds, pathsForRoot, publishState, removeEndpoint, type ServerPaths } from './lifecycle.js';
import { NdjsonReader, WIRE_VERSION, type WireFrame, type WireRequest, writeFrame } from './wire.js';
import { createSemanticContext } from './context.js';
import { executeSemantic } from '../commands/handlers.js';
import { findNode } from '../commands/tree.js';

interface Queued { request: WireRequest; socket: Socket; }

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

  const semantic = createSemanticContext(root, (chunk) => appendFileSync(paths.log, chunk));
  const { session, projects } = semantic;
  let bootstrapped = false;
  let stopping = false;
  let active = false;
  let queue: Queued[] = [];
  const sockets = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!active && queue.length === 0) shutdown(); }, idleSeconds() * 1000);
    idleTimer.unref();
  };
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    for (const socket of sockets) { try { send(socket, { type: 'phase', requestId: '', phase: 'stopping' }); } catch {} }
    server.close();
    removeEndpoint(paths);
    session.stop();
    try { database.close(); } catch {}
    process.exit(0);
  };
  const processQueue = async (): Promise<void> => {
    if (active || stopping) return;
    const queued = queue.shift();
    if (!queued) { touch(); return; }
    if (queued.socket.destroyed) { void processQueue(); return; }
    active = true;
    send(queued.socket, { type: 'phase', requestId: queued.request.requestId, phase: 'running', remainingMs: 120_000 });
    try {
      if (!bootstrapped) {
        send(queued.socket, { type: 'phase', requestId: queued.request.requestId, phase: 'project-load-start', remainingMs: 60_000 });
        await projects.bootstrap();
        bootstrapped = true;
        send(queued.socket, { type: 'phase', requestId: queued.request.requestId, phase: 'project-load-end', remainingMs: 60_000 });
      }
      const requestInvocation = queued.request.invocation;
      if (!requestInvocation) throw new Error('invoke request omitted its invocation');
      const declaration = findNode(requestInvocation.path).node;
      const completion = await executeSemantic(semantic, { root, json: false, path: requestInvocation.path, declaration, input: { args: requestInvocation.args, flags: requestInvocation.flags, explicit: new Set(requestInvocation.explicit) } });
      if ('category' in completion && !completion.logPath) completion.logPath = paths.log;
      send(queued.socket, { type: 'response', requestId: queued.request.requestId, completion: 'category' in completion ? { error: completion } : { answer: completion } });
    } catch (error) {
      send(queued.socket, { type: 'response', requestId: queued.request.requestId, completion: { error: { category: 'tool' as const, code: 'project-load-failed', message: 'TypeScript could not load the workspace project.', logPath: paths.log, next: error instanceof Error ? error.message : 'Read the log and repair the project.' } } });
    } finally { active = false; void processQueue(); }
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    const reader = new NdjsonReader();
    socket.on('data', (chunk) => {
      for (const value of reader.push(chunk)) receive(value, socket);
    });
    socket.on('close', () => { sockets.delete(socket); queue = queue.filter((queued) => queued.socket !== socket); });
    socket.on('error', () => {});
  });
  const receive = (value: unknown, socket: Socket) => {
    const request = value as Partial<WireRequest>;
    if (request.version !== WIRE_VERSION || request.root !== root || typeof request.requestId !== 'string' || !request.operation) {
      send(socket, { type: 'response', requestId: typeof request.requestId === 'string' ? request.requestId : '', completion: { error: { category: 'tool', code: 'server-unavailable', message: 'The resident received an invalid wire request.', logPath: paths.log, next: 'Retry with the installed symbols CLI.' } } });
      socket.end();
      return;
    }
    if (request.operation === 'status') {
      send(socket, { type: 'response', requestId: request.requestId, completion: { answer: { element: 'server', attributes: { root, state: 'ready', pid: process.pid, port: paths.port, log: paths.log, idle: `${idleSeconds()}s`, tsserver: session.location.path, typescript: session.location.version }, count: 1 } } });
      return;
    }
    if (request.operation === 'stop') {
      send(socket, { type: 'phase', requestId: request.requestId, phase: 'stopping' });
      send(socket, { type: 'response', requestId: request.requestId, completion: { answer: { element: 'server', attributes: { root, state: 'stopping' }, count: 1 } } });
      setImmediate(shutdown);
      return;
    }
    if (stopping) {
      send(socket, { type: 'response', requestId: request.requestId, completion: { error: { category: 'tool', code: 'server-unavailable', message: 'The resident is stopping.', logPath: paths.log, next: 'Wait for stop to complete before invoking symbols.' } } });
      return;
    }
    touch();
    send(socket, { type: 'phase', requestId: request.requestId, phase: 'accepted', remainingMs: 30_000 });
    send(socket, { type: 'phase', requestId: request.requestId, phase: 'queued', remainingMs: 30_000 });
    queue.push({ request: request as WireRequest, socket });
    processQueue();
  };

  removeEndpoint(paths);
  server.listen(paths.port, () => {
    chmodSync(paths.port, 0o600);
    publishState(paths, { root, pid: process.pid, bootedAt: new Date().toISOString(), port: paths.port, log: paths.log, idleDeadline: new Date(Date.now() + idleSeconds() * 1000).toISOString(), state: 'ready' });
    append(paths, `ready pid=${process.pid} root=${root}`);
    touch();
  });
  server.on('error', (error) => { append(paths, `socket failure: ${safe(error)}`); shutdown(); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  void logFd;
}

function send(socket: Socket, frame: WireFrame): void { writeFrame(socket, frame); }
function arg(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function isBusy(error: unknown): boolean { return (error as { code?: string; errcode?: number }).code === 'ERR_SQLITE_ERROR' && (error as { errcode?: number }).errcode === 5 || String(error).includes('database is locked'); }
function append(paths: ServerPaths, message: string): void { appendFileSync(paths.log, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }); }
function safe(error: unknown): string { return error instanceof Error ? error.message : String(error); }

void main();
