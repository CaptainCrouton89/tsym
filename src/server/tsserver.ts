import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

interface ProtocolMessage { type?: string; event?: string; seq?: number; request_seq?: number; success?: boolean; command?: string; body?: unknown; message?: string; }
export interface TsServerLocation { path: string; version: string; }
export interface FilePosition { file: string; line: number; offset: number; }

export class TsServerSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private pending: { seq: number; resolve: (message: ProtocolMessage) => void; reject: (error: Error) => void } | null = null;
  private events: ProtocolMessage[] = [];
  readonly location: TsServerLocation;

  constructor(readonly root: string, location = resolveTsserver(root), private readonly onStderr: (chunk: Buffer) => void = () => {}) { this.location = location; }

  start(): void {
    if (this.child) return;
    const child = spawn(process.execPath, [this.location.path, '--disableAutomaticTypingAcquisition'], { cwd: this.root, stdio: 'pipe' });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`tsserver exited (${code ?? signal ?? 'unknown'})`)));
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.kill('SIGTERM');
  }

  async request(command: string, args: Record<string, unknown> = {}): Promise<ProtocolMessage> {
    this.start();
    if (this.pending) throw new Error(`tsserver request ${command} attempted while ${this.pending.seq} is pending`);
    const seq = ++this.seq;
    const body = JSON.stringify({ seq, type: 'request', command, arguments: args }) + '\n';
    return new Promise<ProtocolMessage>((resolve, reject) => {
      this.pending = { seq, resolve, reject };
      this.child!.stdin.write(body, (error) => { if (error) this.fail(error); });
    });
  }

  async open(file: string): Promise<void> { await this.success('open', { file, projectRootPath: this.root }); }
  async close(file: string): Promise<void> { await this.success('close', { file }); }
  async projectInfo(file: string): Promise<{ configFileName?: string; fileNames?: string[] }> { return (await this.success('projectInfo', { file, needFileNameList: true })).body as { configFileName?: string; fileNames?: string[] }; }
  async definition(position: FilePosition): Promise<unknown> { return (await this.success('definitionAndBoundSpan', { ...position })).body; }
  async navtree(file: string): Promise<unknown> { return (await this.success('navtree', { file })).body; }
  async navto(searchValue: string): Promise<unknown> { return (await this.success('navto', { searchValue })).body; }
  async quickinfo(position: FilePosition): Promise<unknown> { return (await this.success('quickinfo', { ...position })).body; }

  drainEvents(event?: string): ProtocolMessage[] {
    const matches = this.events.filter((item) => event === undefined || item.event === event);
    this.events = event === undefined ? [] : this.events.filter((item) => item.event !== event);
    return matches;
  }

  async withOpen<T>(file: string, run: () => Promise<T>): Promise<T> {
    await this.open(file);
    try { return await run(); }
    finally { await this.close(file); }
  }

  private async success(command: string, args: Record<string, unknown>): Promise<ProtocolMessage> {
    const response = await this.request(command, args);
    if (response.success === false) throw new TsServerError(command, response.message ?? 'TypeScript rejected the request.');
    return response;
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const separator = this.buffer.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const header = this.buffer.subarray(0, separator).toString('ascii');
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) { this.fail(new Error(`Invalid tsserver header: ${header}`)); return; }
      const length = Number(match[1]);
      const start = separator + 4;
      if (this.buffer.length < start + length) return;
      const payload = this.buffer.subarray(start, start + length);
      this.buffer = this.buffer.subarray(start + length);
      let message: ProtocolMessage;
      try { message = JSON.parse(payload.toString('utf8')) as ProtocolMessage; } catch (error) { this.fail(error as Error); return; }
      if (message.type === 'event') { this.events.push(message); continue; }
      if (message.type === 'response' && this.pending && message.request_seq === this.pending.seq) {
        const pending = this.pending;
        this.pending = null;
        pending.resolve(message);
      }
    }
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) pending.reject(error);
  }
}

export class TsServerError extends Error { constructor(readonly command: string, message: string) { super(message); } }

export function resolveTsserver(root: string): TsServerLocation {
  const workspace = path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js');
  const serverPath = existsSync(workspace) ? workspace : createRequire(import.meta.url).resolve('typescript/lib/tsserver.js');
  const compiler = createRequire(import.meta.url)(serverPath.replace(/tsserver\.js$/, 'typescript.js')) as { version: string };
  return { path: serverPath, version: compiler.version };
}
