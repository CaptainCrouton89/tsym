import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolError } from './types.js';

export interface RenameEdit {
  startByte: number;
  endByte: number;
  line: number;
  col: number;
  oldText: string;
  replacement: string;
}

export interface RenameFilePlan {
  path: string;
  snapshot: string;
  edits: RenameEdit[];
}

export interface RenamePlan {
  root: string;
  symbol: string;
  from: string;
  to: string;
  files: RenameFilePlan[];
}

export type RenameAnswer = { renamePlan: RenamePlan };

export interface RenameFileOperations {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  chmod: typeof chmod;
}

const filesystem: RenameFileOperations = { readFile, writeFile, rename, rm, stat, chmod };

interface PreparedFile {
  file: RenameFilePlan;
  original: Buffer;
  replacement: Buffer;
  mode: number;
  temp: string;
  restore: string;
  replaced: boolean;
}

/** Apply a complete compiler-produced plan without asking the resident to recompute it. */
export async function applyRenamePlan(plan: RenamePlan, operations: RenameFileOperations = filesystem): Promise<{ applied: true } | ToolError> {
  const prepared: PreparedFile[] = [];
  try {
    for (const file of orderedFiles(plan)) {
      const absolute = absolutePath(plan.root, file.path);
      const original = await operations.readFile(absolute);
      if (!original.equals(Buffer.from(file.snapshot, 'base64'))) return writeFailure(`The source changed after the rename preview: ${file.path}.`, 'Re-run rename to produce a plan for the current source.');
      const replacement = applyEdits(original, file);
      const metadata = await operations.stat(absolute);
      const suffix = `.symbols-rename-${randomUUID()}`;
      prepared.push({ file, original, replacement, mode: metadata.mode & 0o7777, temp: `${absolute}${suffix}.new`, restore: `${absolute}${suffix}.restore`, replaced: false });
    }

    for (const entry of prepared) {
      await operations.writeFile(entry.temp, entry.replacement, { mode: entry.mode, flag: 'wx' });
      await operations.chmod(entry.temp, entry.mode);
      await operations.writeFile(entry.restore, entry.original, { mode: entry.mode, flag: 'wx' });
      await operations.chmod(entry.restore, entry.mode);
    }
  } catch (error) {
    await removePrepared(prepared, operations);
    return writeFailure(`Rename preparation failed: ${message(error)}.`, 'Fix the filesystem error, then re-run rename.');
  }

  try {
    for (const entry of prepared) {
      await operations.rename(entry.temp, absolutePath(plan.root, entry.file.path));
      entry.replaced = true;
    }
    for (const entry of prepared) await operations.rm(entry.restore, { force: false });
    return { applied: true };
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const entry of [...prepared].reverse()) {
      if (!entry.replaced) continue;
      try {
        await operations.rename(entry.restore, absolutePath(plan.root, entry.file.path));
        entry.replaced = false;
      } catch {
        rollbackFailures.push(entry.restore);
      }
    }
    await removePrepared(prepared, operations, new Set(rollbackFailures));
    if (rollbackFailures.length > 0) {
      return {
        category: 'tool',
        code: 'rename-rollback-failed',
        message: `Rename commit failed (${message(error)}) and restoration also failed. Original backups remain at: ${rollbackFailures.join(', ')}.`,
        received: rollbackFailures.join(', '),
        expected: 'the listed original-content backups to remain available for manual restoration',
        next: 'Restore the listed backups over their source files before retrying rename.',
      };
    }
    return writeFailure(`Rename commit failed and every replaced file was restored: ${message(error)}.`, 'Fix the filesystem error, then re-run rename.');
  }
}

function orderedFiles(plan: RenamePlan): RenameFilePlan[] { return [...plan.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0); }
function absolutePath(root: string, file: string): string { return path.resolve(root, file); }

function applyEdits(source: Buffer, file: RenameFilePlan): Buffer {
  const edits = [...file.edits].sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  let previous = 0;
  for (const edit of edits) {
    if (!Number.isInteger(edit.startByte) || !Number.isInteger(edit.endByte) || edit.startByte < previous || edit.endByte < edit.startByte || edit.endByte > source.length) throw new Error(`Invalid or overlapping edit in ${file.path}.`);
    previous = edit.endByte;
  }
  const chunks: Buffer[] = [];
  let end = source.length;
  for (const edit of [...edits].reverse()) {
    chunks.unshift(source.subarray(edit.endByte, end));
    chunks.unshift(Buffer.from(edit.replacement));
    end = edit.startByte;
  }
  chunks.unshift(source.subarray(0, end));
  return Buffer.concat(chunks);
}

async function removePrepared(prepared: readonly PreparedFile[], operations: RenameFileOperations, retain = new Set<string>()): Promise<void> {
  await Promise.all(prepared.flatMap((entry) => [entry.temp, entry.restore]).filter((file) => !retain.has(file)).map(async (file) => { try { await operations.rm(file, { force: true }); } catch {} }));
}

function writeFailure(message: string, next: string): ToolError {
  return { category: 'tool', code: 'rename-write-failed', message, expected: 'every file in the preview to still match its recorded source snapshot', next };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
