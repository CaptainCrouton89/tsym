import { randomUUID } from 'node:crypto';
import type { Answer, Invocation, InvocationError, ToolError } from '../commands/types.js';

export const WIRE_VERSION = 1;
export type Operation = 'invoke' | 'status' | 'stop';

export interface WireInvocation { path: string[]; cwd: string; args: string[]; flags: Invocation['input']['flags']; explicit: string[]; }

export interface WireRequest {
  version: typeof WIRE_VERSION;
  requestId: string;
  root: string;
  operation: Operation;
  invocation?: WireInvocation;
}

export interface PhaseFrame {
  type: 'phase';
  requestId: string;
  phase: 'accepted' | 'queued' | 'running' | 'project-load-start' | 'project-load-end' | 'command-start' | 'stopping';
  remainingMs?: number;
  command?: string;
}

export interface ResponseFrame {
  type: 'response';
  requestId: string;
  completion: { answer?: Answer; error?: InvocationError | ToolError };
}

export type WireFrame = PhaseFrame | ResponseFrame;

export function request(root: string, operation: Operation, invocation?: Invocation): WireRequest {
  return { version: WIRE_VERSION, requestId: randomUUID(), root, operation, invocation: invocation ? { path: invocation.path, cwd: invocation.cwd, args: invocation.input.args, flags: invocation.input.flags, explicit: [...invocation.input.explicit] } : undefined };
}

export function writeFrame(stream: NodeJS.WritableStream, frame: WireRequest | WireFrame): void { stream.write(JSON.stringify(frame) + '\n'); }

export class NdjsonReader {
  private buffered = '';
  push(chunk: Buffer | string): unknown[] {
    this.buffered += chunk.toString();
    const lines = this.buffered.split('\n');
    this.buffered = lines.pop()!;
    const values: unknown[] = [];
    for (const line of lines) if (line) values.push(JSON.parse(line));
    return values;
  }
}
