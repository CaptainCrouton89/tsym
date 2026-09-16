import { execFileSync } from 'node:child_process';
import { describeSourceFile, parseDescriptorSource, type KeyedDeclaration } from './descriptor.js';
import type { RelationshipRow } from '../store/load.js';
import { Store } from '../store/store.js';

export interface RenameCandidate {
  from: string;
  oldKey: string;
  basis: 'text-identical' | 'container-renamed' | 'file-moved';
  commit: string;
}

export interface CommitIngestion {
  commits: readonly string[];
  changed: readonly RelationshipRow[];
  renamed: readonly RenameCandidate[];
}

interface CurrentDeclaration { key: string; file: string; endLine: number; lines: number; }
interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; }
interface SpanDeclaration { key: string; name: string; startLine: number; endLine: number; }
interface BlobDeclaration extends KeyedDeclaration, SpanDeclaration { text: string; }

/** Ingests missing commits against working-tree identities. Committed blobs are parsed only by the TS5 descriptor. */
export function ingestCommits(root: string, store: Store, hashes: readonly string[]): CommitIngestion {
  const current = currentDeclarations(store);
  const commits: string[] = [];
  const changed: RelationshipRow[] = [];
  const renamed: RenameCandidate[] = [];
  for (const hash of hashes) {
    if (commitExists(store, hash)) continue;
    const ingestion = ingestCommit(root, hash, current);
    store.transaction(() => {
      store.execute('CREATE (:Commit {hash: $hash, ts: $ts, author: $author, subject: $subject})', commitDetails(root, hash));
      for (const relationship of ingestion.changed) {
        store.execute('MATCH (c:Commit), (d:Declaration) WHERE c.hash = $commit AND d.key = $key CREATE (c)-[:CHANGED {added: $added, removed: $removed}]->(d)', {
          commit: hash,
          key: relationship.to,
          added: relationship.added ?? 0,
          removed: relationship.removed ?? 0,
        });
      }
    });
    commits.push(hash);
    changed.push(...ingestion.changed);
    renamed.push(...ingestion.renamed);
  }
  return { commits, changed, renamed };
}

function ingestCommit(root: string, hash: string, current: ReadonlyMap<string, CurrentDeclaration>): Omit<CommitIngestion, 'commits'> {
  const parent = parentOf(root, hash);
  const changed = new Map<string, { added: number; removed: number }>();
  const renamed: RenameCandidate[] = [];
  for (const file of touchedFiles(root, parent, hash)) {
    if (!isSourceFile(file)) continue;
    const afterBlob = cleanAtCommit(root, hash, file) ? undefined : descriptorsAt(root, hash, file);
    const after: readonly SpanDeclaration[] = afterBlob ?? currentSpans(current, file);
    const before = parent === undefined ? [] : descriptorsAt(root, parent, file);
    const afterIndexed = after.filter((declaration) => current.has(declaration.key));
    const beforeByKey = new Map(before.map((declaration) => [declaration.key, declaration]));
    for (const hunk of hunksFor(root, parent, hash, file)) {
      if (hunk.newLines === 0) {
        const target = deletionTarget(afterIndexed, hunk.newStart);
        if (target) add(changed, target.key, 0, hunk.oldLines);
        continue;
      }
      const affected = afterIndexed.filter((declaration) => declaration.name !== '<module>' && intersects(declaration.startLine, declaration.endLine, hunk.newStart, hunk.newStart + hunk.newLines - 1));
      const targets = affected.length === 0 ? (moduleFor(afterIndexed) === undefined ? [] : [moduleFor(afterIndexed)!]) : affected;
      for (const target of targets) {
        const previous = beforeByKey.get(target.key);
        const removed = previous && hunk.oldLines > 0
          ? intersection(previous.startLine, previous.endLine, hunk.oldStart, hunk.oldStart + hunk.oldLines - 1)
          : 0;
        add(changed, target.key, intersection(target.startLine, target.endLine, hunk.newStart, hunk.newStart + hunk.newLines - 1), removed);
      }
    }
    if (afterBlob !== undefined) renamed.push(...renameCandidates(hash, before, afterBlob, current));
  }
  return {
    changed: [...changed].map(([to, counts]) => ({ type: 'CHANGED', from: hash, to, target: 'Declaration', ...counts })),
    renamed,
  };
}

function currentDeclarations(store: Store): Map<string, CurrentDeclaration> {
  const rows = store.execute('MATCH (d:Declaration) RETURN d.key AS key, d.file AS file, d.endLine AS endLine, d.lines AS lines');
  return new Map(rows.map((row) => [String(row.key), { key: String(row.key), file: String(row.file), endLine: Number(row.endLine), lines: Number(row.lines) }]));
}

function commitExists(store: Store, hash: string): boolean {
  return store.execute('MATCH (c:Commit) WHERE c.hash = $hash RETURN c.hash', { hash }).length > 0;
}

function commitDetails(root: string, hash: string): { hash: string; ts: string; author: string; subject: string } {
  const values = git(root, ['show', '-s', '--format=%aI%x00%an%x00%s', hash]).split('\0');
  if (values.length !== 3) throw new Error(`Git did not return commit metadata for ${hash}.`);
  return { hash, ts: values[0]!, author: values[1]!, subject: values[2]!.trimEnd() };
}

function parentOf(root: string, hash: string): string | undefined {
  return git(root, ['rev-list', '--parents', '-n', '1', hash]).trim().split(/\s+/)[1];
}

function touchedFiles(root: string, parent: string | undefined, hash: string): string[] {
  const args = parent === undefined
    ? ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', hash]
    : ['diff', '--name-only', parent, hash];
  return git(root, args).split('\n').filter(Boolean);
}

function hunksFor(root: string, parent: string | undefined, hash: string, file: string): Hunk[] {
  const args = parent === undefined
    ? ['diff-tree', '--root', '--no-commit-id', '--unified=0', '-r', hash, '--', file]
    : ['diff', '--unified=0', parent, hash, '--', file];
  return git(root, args).split('\n').flatMap((line) => {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    return match ? [{ oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1) }] : [];
  });
}

function descriptorsAt(root: string, commit: string, file: string): BlobDeclaration[] {
  let text: string;
  try { text = git(root, ['show', `${commit}:${file}`]); }
  catch (error: unknown) {
    if (/does not exist in|exists on disk, but not in/.test(String(error))) return [];
    throw error;
  }
  const source = parseDescriptorSource(file, text);
  return describeSourceFile(source, file).map((declaration) => ({
    ...declaration,
    startLine: source.getLineAndCharacterOfPosition(declaration.start).line + 1,
    endLine: source.getLineAndCharacterOfPosition(Math.max(declaration.start, declaration.end - 1)).line + 1,
    text: text.slice(declaration.start, declaration.end).replace(/\s+/g, ' ').trim(),
  }));
}

function currentSpans(current: ReadonlyMap<string, CurrentDeclaration>, file: string): SpanDeclaration[] {
  return [...current.values()].filter((declaration) => declaration.file === file).map((declaration) => ({
    key: declaration.key,
    name: declaration.key.endsWith('#<module>') ? '<module>' : declaration.key.slice(declaration.key.lastIndexOf('.') + 1),
    startLine: declaration.endLine - declaration.lines + 1,
    endLine: declaration.endLine,
  }));
}

function cleanAtCommit(root: string, hash: string, file: string): boolean {
  try { execFileSync('git', ['diff', '--quiet', hash, '--', file], { cwd: root }); return true; }
  catch { return false; }
}

function deletionTarget<T extends SpanDeclaration>(declarations: readonly T[], line: number): T | undefined {
  const nonModules = declarations.filter((declaration) => declaration.name !== '<module>');
  const preceding = nonModules.filter((declaration) => declaration.endLine === line - 1);
  if (preceding.length > 0) return innermost(preceding);
  const containing = nonModules.filter((declaration) => declaration.startLine <= line && line <= declaration.endLine);
  return containing.length > 0 ? innermost(containing) : moduleFor(declarations);
}

function moduleFor<T extends { name: string }>(declarations: readonly T[]): T | undefined {
  return declarations.find((declaration) => declaration.name === '<module>');
}

function innermost<T extends SpanDeclaration>(declarations: readonly T[]): T {
  return [...declarations].sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine) || left.key.localeCompare(right.key))[0]!;
}

/** Candidates retain the vanished key until the approved schema can represent it. They are intentionally not persisted yet. */
function renameCandidates(commit: string, before: readonly BlobDeclaration[], after: readonly BlobDeclaration[], current: ReadonlyMap<string, CurrentDeclaration>): RenameCandidate[] {
  const oldByText = new Map<string, BlobDeclaration[]>();
  for (const declaration of before) {
    if (declaration.name === '<module>' || current.has(declaration.key)) continue;
    const candidates = oldByText.get(declaration.text) ?? [];
    candidates.push(declaration);
    oldByText.set(declaration.text, candidates);
  }
  const candidates: RenameCandidate[] = [];
  for (const declaration of after) {
    if (declaration.name === '<module>' || !current.has(declaration.key)) continue;
    const matches = oldByText.get(declaration.text) ?? [];
    if (matches.length !== 1) continue;
    const old = matches[0]!;
    if (old.key === declaration.key) continue;
    candidates.push({
      from: declaration.key,
      oldKey: old.key,
      basis: old.file !== declaration.file ? 'file-moved' : old.containerPath !== declaration.containerPath ? 'container-renamed' : 'text-identical',
      commit,
    });
  }
  return candidates;
}

function add(target: Map<string, { added: number; removed: number }>, key: string, added: number, removed: number): void {
  const previous = target.get(key) ?? { added: 0, removed: 0 };
  previous.added += added;
  previous.removed += removed;
  target.set(key, previous);
}

function intersects(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start <= otherEnd && otherStart <= end;
}

function intersection(start: number, end: number, otherStart: number, otherEnd: number): number {
  return Math.max(0, Math.min(end, otherEnd) - Math.max(start, otherStart) + 1);
}

function isSourceFile(file: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(file);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
