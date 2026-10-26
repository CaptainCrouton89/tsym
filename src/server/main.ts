import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Socket } from 'node:net';
import { appendFileSync, chmodSync, existsSync, openSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { discoverRoot, ensureStateDirectory, idleSeconds, maxResidents, pathsForRoot, publishState, removeEndpoint, type ServerPaths } from './lifecycle.js';
import { NdjsonReader, WIRE_VERSION, type WireFrame, type WireRequest, writeFrame } from './wire.js';
import { createSemanticContext } from './context.js';
import { bundledTypeScriptVersion, Ts7ServerDiedError, TypeScriptBinaryError } from '../ts7/api.js';
import { buildIndex, reuseIndex } from '../index/build.js';
import { ingestCommits } from '../index/commits.js';
import { refreshIndex } from '../index/refresh.js';
import { IndexStateController } from '../index/state.js';
import { watchIndex, type IndexWatcher, type WatchBatch } from '../index/watch.js';
import { changedFiles, discardIncompatibleStore, formatIdentity, hasDrift, metadataFor, readMetadata, writeMetadata, type StoreFormatIdentity, type StoreMetadata } from '../store/meta.js';
import { copyStore, refuseSeed, seedFromSibling } from '../store/seed.js';
import { EngineBinaryError, openStore, Store, StoreRecoveryError } from '../store/store.js';
import { executeSemantic } from '../commands/handlers.js';
import { findNode } from '../commands/tree.js';
import type { Completion, OutputNode, ToolError } from '../commands/types.js';
import type { ProjectRegistry } from './projects.js';

interface Queued {
  request: WireRequest;
  socket: Socket;
  remainingQueueMs: number;
  queueStartedAt?: number;
  queueTimer?: NodeJS.Timeout;
}

class DeadlineExceeded extends Error {
  constructor(readonly phase: 'project-load' | 'index-build') { super(`${phase} deadline exceeded`); }
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
  /** Set while answers come from the stored index because the live index has not loaded yet. */
  let storedIndex: { metadata: StoreMetadata; expected: () => StoreMetadata } | undefined;
  let deferredIndex: (() => Promise<void>) | undefined;
  let indexing: Promise<void> | undefined;
  /** A background live-index build that failed after a stored-index answer; reported by status and returned to the next request. */
  let indexFailure: unknown;
  let seededFrom: string | undefined;
  let loading = false;
  let stopping = false;
  let retired = false;
  let active: Queued | undefined;
  let queue: Queued[] = [];
  let currentCommand: string | undefined;
  let loadDeadlineAt: number | undefined;
  let indexBuildDeadlineAt: number | undefined;
  let activeDeadlineAt: number | undefined;
  let activeTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleDeadline = new Date(Date.now() + idleSeconds() * 1000).toISOString();
  let listenerClosing = false;
  const sockets = new Set<Socket>();
  const invokeSockets = new Map<Socket, string>();
  const stopRequests: { requestId: string; socket: Socket }[] = [];
  const closeProgram = () => {
    try { semantic?.program.close(); }
    catch (error) { append(paths, `TypeScript 7 shutdown failure: ${safe(error)}`); }
  };
  const publishedState = (snapshot = index?.current()) => ({
    root,
    pid: process.pid,
    bootedAt: bootedAt.toISOString(),
    port: paths.port,
    log: paths.log,
    idleDeadline,
    state: stopping ? 'stopping' as const : 'ready' as const,
    index: snapshot === undefined ? undefined : snapshot.state === 'current' ? 'current' as const : 'stale' as const,
    declarations: snapshot?.built.receipt.declarations,
  });

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
    idleDeadline = new Date(Date.now() + idleSeconds() * 1000).toISOString();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!active && queue.length === 0) retire();
    }, idleSeconds() * 1000);
    idleTimer.unref();
    publishState(paths, publishedState());
  };

  const remaining = (deadlineAt: number | undefined) => Math.max(0, Math.ceil((deadlineAt ?? performance.now()) - performance.now()));
  const sendPhase = (socket: Socket, requestId: string, phase: Extract<WireFrame, { type: 'phase' }>['phase'], remainingMs?: number, command?: string) => {
    if (!socket.destroyed) send(socket, { type: 'phase', requestId, phase, remainingMs, command });
  };
  const toolError = (code: string, message: string, next: string): ToolError => ({ category: 'tool', code, message, logPath: paths.log, next });
  const loadFailure = (error: unknown): ToolError => {
    if (!(error instanceof StoreRecoveryError)) return ({ ...toolError('project-load-failed', 'TypeScript could not load the workspace project.', 'Pass --root at a repository or package directory with a tsconfig.json, or read the log.'), received: error instanceof Error ? error.message : String(error) });
    append(paths, `store recovery failed: ${error.message}`);
    return error.preserved === undefined
      ? toolError('store-recovery-failed', `The tsym index store at ${error.storePath} is corrupt and could not be moved aside.`, `${error.reason} The corrupt store is still at ${error.storePath}; fix the cause, or remove that directory, then retry.`)
      : toolError('store-recovery-failed', `The tsym index store at ${error.storePath} was corrupt and could not be rebuilt.`, `${error.reason} The corrupt store is kept at ${error.preserved}; read the log, then retry.`);
  };
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

  const startupDeadlineFailure = (phase: 'project-load' | 'index-build') => phase === 'project-load'
    ? toolError('project-load-timeout', 'TypeScript did not load the workspace project before its deadline.', 'Repair the project, then retry.')
    : toolError('index-build-timeout', 'The workspace index did not build before its deadline.', 'Repair the project, then retry.');
  const startupTimeout = (phase: 'project-load' | 'index-build') => {
    if (retired) return;
    const completion = startupDeadlineFailure(phase);
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

  const sendStartupPhase = (phase: Extract<WireFrame, { type: 'phase' }>['phase'], remainingMs: number | undefined, startup?: { socket: Socket; requestId: string }) => {
    if (active) sendPhase(active.socket, active.request.requestId, phase, remainingMs);
    for (const queued of queue) sendPhase(queued.socket, queued.request.requestId, phase, remainingMs);
    if (startup) sendPhase(startup.socket, startup.requestId, phase, remainingMs);
  };
  // A failed load must leave nothing open, or the next attempt fails on store ownership instead of its real cause.
  const unload = () => {
    watcher?.close(); watcher = undefined;
    store?.close(); store = undefined;
    if (semantic) semantic.store = undefined;
    storedIndex = undefined;
    deferredIndex = undefined;
    bootstrapped = false;
  };

  /**
   * Loads the TypeScript projects and opens the store. A compatible stored index is served at once while the live index
   * waits in `deferredIndex`; with no stored index to serve, the live index is built before this resolves.
   */
  const loadProjects = async (startup?: { socket: Socket; requestId: string }) => {
    loading = true;
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      loadDeadlineAt = performance.now() + 60_000;
      for (const queued of queue) pauseQueueDeadline(queued);
      sendStartupPhase('project-load-start', 60_000, startup);
      semantic ??= createSemanticContext(root);
      const { projects } = semantic;
      const { configured, identity, expected } = await Promise.race([
        (async () => {
          await projects.bootstrap();
          const configured = projects.configured();
          const identity = formatIdentity();
          if (discardIncompatibleStore(paths.store, identity)) append(paths, 'discarded an incompatible store');
          const expected = metadataFor(root, configured, headCommit(root), 0, identity);
          if (!forceRebuild && readMetadata(paths.store) === null) {
            const seeded = await seedFromSibling(root, paths, expected, identity);
            if (seeded) {
              seededFrom = seeded.root;
              append(paths, `store seeded from ${seeded.root} bytes=${seeded.bytes} duration=${Math.round(seeded.durationMs)}ms`);
            } else append(paths, 'store seed skipped: no identical sibling');
          }
          return { configured, identity, expected };
        })(),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new DeadlineExceeded('project-load')), 60_000);
          deadlineTimer.unref();
        }),
      ]);
      clearTimeout(deadlineTimer);
      loadDeadlineAt = undefined;
      const opened = openStore(paths.store, (message) => append(paths, message));
      store = opened.store;
      // A recovered store is empty; bypass its (absent) metadata explicitly so nothing reuses or seeds around the rebuild.
      const rebuild = forceRebuild || opened.recovered !== undefined;
      const metadata = rebuild ? null : readMetadata(store.path);
      bootstrapped = true;
      if (metadata !== null) {
        storedIndex = { metadata, expected: () => metadataFor(root, configured, headCommit(root), 0, identity) };
        semantic.store = store;
        deferredIndex = () => indexProjects(configured, identity, metadata, undefined);
        append(paths, `answering from the stored index indexedAt=${metadata.indexedAt} changedSince=${changedSince(metadata, expected)}`);
      } else {
        loading = false;
        await indexProjects(configured, identity, null, opened.recovered, startup);
      }
    } catch (error) {
      unload();
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      loading = false;
      loadDeadlineAt = undefined;
      if (bootstrapped && !retired) for (const queued of queue) armQueueDeadline(queued);
    }
  };

  /** Walks the program, or rehydrates the stored graph and refreshes it when the workspace drifted, then publishes the live index. */
  const indexProjects = async (configured: ReturnType<ProjectRegistry['configured']>, identity: StoreFormatIdentity, metadata: StoreMetadata | null, recovered: { preserved: string } | undefined, startup?: { socket: Socket; requestId: string }) => {
    loading = true;
    deferredIndex = undefined;
    for (const queued of queue) pauseQueueDeadline(queued);
    const program = semantic!.program;
    indexBuildDeadlineAt = performance.now() + 180_000;
    sendStartupPhase('index-build-start', 180_000, startup);
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      if (metadata !== null) {
        // Re-read configs and membership now: the watcher sees only edits from here on, so a config edit or a new source
        // file since project load would otherwise be missing from an index published as current. The update must precede
        // the rediscovery, which reads membership from the updated config text.
        program.update({ fileChanges: { invalidateAll: true } });
        configured.reload();
      }
      // The watcher starts before the build, not after it: buildIndex takes tens of seconds on a large workspace,
      // and an edit landing in that window would otherwise never be recorded, publishing a stale index as current.
      // buildIndex is synchronous, so no watch callback can run until index is assigned below.
      watcher = watchIndex(root, configured, refresh, (error) => append(paths, `index refresh failure: ${safe(error)}`), (flush) => index?.markStale(flush));
      let built: ReturnType<typeof buildIndex> | undefined;
      await Promise.race([
        (async () => {
          if (metadata !== null) {
            const reused = reuseIndex(store!);
            // Measured now, not at project load: an edit made while the stored index was answering must still be indexed.
            if (hasDrift(metadata, metadataFor(root, configured, headCommit(root), 0, identity))) {
              const refreshed = refreshIndex(root, program, configured, store!, reused, { fileChanges: { invalidateAll: true } }, identity);
              append(paths, `index refresh stored=${refreshed.stored} changedFiles=${refreshed.changedFiles.length} duration=${Math.round(refreshed.built.receipt.durationMs)}ms`);
              built = refreshed.built;
            } else built = reused;
          } else {
            try { built = buildIndex(root, program, configured, store!, identity); }
            catch (error) { throw recovered ? new StoreRecoveryError(paths.store, recovered.preserved, error) : error; }
            if (recovered) append(paths, `store recovered: fresh index built, corrupt store kept at ${recovered.preserved} duration=${Math.round(built.receipt.durationMs)}ms`);
          }
        })(),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new DeadlineExceeded('index-build')), 180_000);
          deadlineTimer.unref();
        }),
      ]);
      clearTimeout(deadlineTimer);
      const indexBuildRemaining = remaining(indexBuildDeadlineAt);
      indexBuildDeadlineAt = undefined;
      index = new IndexStateController({ indexedAt: indexedAt(root), state: 'current', built: built! }, (snapshot) => {
        semantic!.index = snapshot;
        publishState(paths, publishedState(snapshot));
      });
      built = undefined;
      semantic!.store = store;
      storedIndex = undefined;
      sendStartupPhase('index-build-end', indexBuildRemaining, startup);
    } catch (error) {
      unload();
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      loading = false;
      indexBuildDeadlineAt = undefined;
      if (!retired) for (const queued of queue) armQueueDeadline(queued);
    }
  };

  /** Starts the deferred live index at most once; every caller waits on the same build. */
  const ensureIndex = (): Promise<void> => {
    if (indexing) return indexing;
    if (!deferredIndex) return Promise.resolve();
    const tracked: Promise<void> = deferredIndex().finally(() => { if (indexing === tracked) indexing = undefined; });
    indexing = tracked;
    return tracked;
  };
  /** The live index builds once no stored-index answer is waiting, so queued reads are answered before the walk blocks the resident. */
  const indexWhenIdle = () => setImmediate(() => {
    if (retired || stopping || active || queue.length > 0 || !deferredIndex) return;
    ensureIndex().catch((error) => {
      if (error instanceof DeadlineExceeded) startupTimeout(error.phase);
      else {
        indexFailure = error;
        append(paths, `background index failed; the next request reports it, and the one after reloads the workspace\n${error instanceof Error && error.stack ? error.stack : safe(error)}`);
      }
    });
  });

  /** Labels an answer read from the stored index before the live index loaded, with the index's age and what changed since. */
  const storedAnswer = (completion: Completion): Completion => {
    if (!storedIndex || ('category' in completion && completion.category === 'tool')) return completion;
    const { indexedAt } = storedIndex.metadata;
    const age = ageOf(indexedAt);
    // Measured per answer, not once at startup: the watcher is not running yet, so an edit since startup shows only here.
    const since = changedSince(storedIndex.metadata, storedIndex.expected());
    const label = { index: 'stored', indexedAt, age, changedSince: since };
    const labelled = (node: OutputNode): OutputNode => ({ ...node, attributes: { ...node.attributes, ...label } });
    const changed = since === 'none'
      ? 'no source file changed since'
      : `${since} changed since, so lines and relations there may be out of date`;
    const notice = `answered from the stored index built ${age} (${changed}); the live index is loading`;
    if ('category' in completion) return { ...completion, problems: completion.problems.map((problem) => ({ ...problem, next: `${problem.next ?? ''} This was ${notice}; retry once it has loaded if the input is right.`.trim() })) };
    const receipt = completion.receipt ?? `${completion.count} answer${completion.count === 1 ? '' : 's'}, 0 ms`;
    return { ...completion, data: Array.isArray(completion.data) ? completion.data.map(labelled) : labelled(completion.data), receipt: `${receipt}; ${notice}` };
  };

  const processQueue = async (): Promise<void> => {
    if (active || retired) return;
    if (stopping) { completeStop(); return; }
    const queued = queue.shift();
    if (!queued) { touch(); indexWhenIdle(); return; }
    if (queued.queueTimer) clearTimeout(queued.queueTimer);
    if (queued.socket.destroyed) { void processQueue(); return; }
    active = queued;
    currentCommand = undefined;
    sendPhase(queued.socket, queued.request.requestId, 'running', 120_000);
    // Set while the live index builds, so its failure is not reported as a failure to load the project.
    let building = false;
    try {
      if (!bootstrapped) {
        const failure = indexFailure;
        indexFailure = undefined;
        building = failure !== undefined;
        if (failure !== undefined) throw failure;
        await loadProjects();
      }
      if (retired) return;
      const requestInvocation = queued.request.invocation;
      if (!requestInvocation) throw new Error('invoke request omitted its invocation');
      const declaration = findNode(requestInvocation.path).node;
      // Store readers answer from the stored index while the live index waits; every other command needs the live program walked.
      const fromStoredIndex = storedIndex !== undefined && readsIndex(declaration.handler);
      building = true;
      if (!fromStoredIndex) await ensureIndex();
      building = false;
      if (retired) return;
      armActiveDeadline();
      currentCommand = requestInvocation.path.join(' ');
      if (!fromStoredIndex && readsIndex(declaration.handler)) await index?.wait();
      const answered = await executeSemantic(semantic!, { root, cwd: requestInvocation.cwd, json: false, path: requestInvocation.path, declaration, input: { args: requestInvocation.args, flags: requestInvocation.flags, explicit: new Set(requestInvocation.explicit) } });
      const completion = fromStoredIndex ? storedAnswer(answered) : answered;
      if ('category' in completion && completion.category === 'tool' && !completion.logPath) completion.logPath = paths.log;
      if (!retired) respond(queued.socket, queued.request.requestId, completion);
    } catch (error) {
      // A request that waited on the failed background build receives the failure itself; the next request reloads.
      if (error === indexFailure) indexFailure = undefined;
      if (error instanceof DeadlineExceeded) {
        startupTimeout(error.phase);
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
      if (!retired) {
        if (!bootstrapped) respond(queued.socket, queued.request.requestId, building ? { ...toolError('index-build-failed', 'The project loaded, but tsym could not build its live index.', 'Read the log, then retry; the next call reloads the workspace and builds the index again.'), received: safe(error) } : loadFailure(error));
        else {
          append(paths, `command failed command=${currentCommand ?? 'unknown'}\n${error instanceof Error && error.stack ? error.stack : safe(error)}`);
          const failure = toolError('command-failed', safe(error), 'Read the resident log, then retry the command.');
          failure.received = currentCommand ?? 'unknown';
          respond(queued.socket, queued.request.requestId, failure);
        }
      }
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
    if (!existsSync(root)) {
      append(paths, `workspace root disappeared; stopping resident root=${root}`);
      retire();
      return;
    }
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
      append(paths, `index refresh stored=${refreshed.stored} changedFiles=${refreshed.changedFiles.length} duration=${Math.round(refreshed.built.receipt.durationMs)}ms`);
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
    if (request.operation === 'seed') {
      const dest = request.seed?.dest;
      const refusal = refuseSeed(dest, path.dirname(paths.state), bootstrapped && store !== undefined, store?.busy ?? false);
      if (refusal) respond(socket, request.requestId, toolError('server-unavailable', refusal, 'Retry after the resident is ready with a new destination under the tsym cache.'));
      else {
        try {
          store!.checkpoint();
          const bytes = copyStore(paths.store, dest!);
          respond(socket, request.requestId, { data: { element: 'seed', attributes: { root, store: dest, bytes } }, count: 1 });
        } catch (error) { respond(socket, request.requestId, toolError('server-unavailable', 'The resident could not copy its store.', error instanceof Error ? error.message : 'Retry after the current refresh completes.')); }
      }
      finishSocket(socket);
      return;
    }
    if (request.operation === 'status' && forceRebuild && !bootstrapped) {
      try { await loadProjects({ socket, requestId: request.requestId }); }
      catch (error) {
        if (error instanceof DeadlineExceeded) respond(socket, request.requestId, startupDeadlineFailure(error.phase));
        else if (error instanceof EngineBinaryError || error instanceof TypeScriptBinaryError) respond(socket, request.requestId, { category: 'tool', code: error.code, attributes: { platform: error.platform }, message: error.message });
        else respond(socket, request.requestId, loadFailure(error));
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
      respond(socket, request.requestId, { data: { element: 'server', attributes: { root, state, pid: process.pid, port: paths.port, log: paths.log, idle: `${idleSeconds()}s`, maxResidents: maxResidents(), uptime: `${Math.floor(performance.now() - bootedAtMonotonic)}ms`, memory, typescript: semantic ? bundledTypeScriptVersion() : undefined, store: paths.store, seededFrom, indexedCommit, declarations: receipt?.declarations, edges: receipt ? Object.values(receipt.relationships).reduce((total, count) => total + count, 0) : undefined, notInProgram: semantic ? unconfiguredFileCount(root, semantic.projects.records()) : undefined, index: snapshot?.state ?? (storedIndex ? 'stored' : indexFailure !== undefined ? 'failed' : undefined), indexError: indexFailure !== undefined ? safe(indexFailure) : undefined, indexDuration: receipt ? `${Math.round(receipt.durationMs)}ms` : undefined } }, count: 1 });
      return;
    }
    if (request.operation === 'stop') {
      stopRequests.push({ requestId: request.requestId, socket });
      if (!stopping) {
        stopping = true;
        if (idleTimer) clearTimeout(idleTimer);
        publishState(paths, publishedState());
        for (const [invokeSocket, requestId] of invokeSockets) {
          const deadlineAt = active?.socket === invokeSocket ? (loading ? indexBuildDeadlineAt ?? loadDeadlineAt : activeDeadlineAt) : undefined;
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
    publishState(paths, publishedState());
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

function changedSince(metadata: StoreMetadata, expected: StoreMetadata): string {
  const changed = changedFiles(metadata, expected);
  if (changed > 0) return `${changed} file${changed === 1 ? '' : 's'}`;
  return hasDrift(metadata, expected) ? 'project configuration' : 'none';
}

function ageOf(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return 'at an unknown time';
  if (seconds < 120) return `${seconds} s ago`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
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
