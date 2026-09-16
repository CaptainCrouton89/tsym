import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.argv[2];
const report = path.resolve(process.argv[3] ?? 'query-validation.md');
if (!root || !path.isAbsolute(root) || !existsSync(path.join(root, 'package.json'))) throw new Error('Usage: npm run validate:queries -- /absolute/workspace/root [/absolute/report.md]');
const scratch = path.join(os.homedir(), '.crouter/canvas/scratch');
mkdirSync(scratch, { recursive: true });
const temporary = mkdtempSync(path.join(scratch, 'queryval-'));
const cache = path.join(temporary, 'cache');

const queries = [
  ['Q1 unused exports', 'MATCH (d:Declaration) WHERE d.exported AND NOT EXISTS { MATCH (s:Declaration)-[:REFERENCES]->(d) WHERE s.file <> d.file } RETURN d.key, d.file, d.line, d.col ORDER BY d.key', []],
  ['Q2 public surface', "MATCH (d:Declaration) WHERE d.exported AND d.file = $file OPTIONAL MATCH (r:Declaration)-[ref:REFERENCES]->(d) WITH d, count(ref) AS fanIn OPTIONAL MATCH (caller:Declaration)-[call:CALLS]->(d) WITH d, fanIn, caller.key AS caller, count(call) AS sites ORDER BY sites DESC, caller SKIP 0 WITH d, fanIn, collect(CASE WHEN caller IS NOT NULL THEN {caller: caller, sites: sites} ELSE NULL END) AS callers RETURN d.key, fanIn, coalesce(callers[1:3], []) AS topCallers ORDER BY d.key", ['--param', 'file=src/core/runtime/revive.ts']],
  ['Q3 implementations', 'MATCH (impl:Declaration)-[:IMPLEMENTS]->(target:Declaration) WHERE target.key = $key RETURN DISTINCT impl.key, impl.file, impl.line, impl.col ORDER BY impl.key', ['--param', 'key=src/core/runtime/fleet.ts#FleetRegistry']],
  ['Q4 type mentions', "MATCH (f:Declaration)-[:TYPE_MENTION]->(t:Declaration) WHERE t.key = $key AND f.kind IN ['function','method'] RETURN DISTINCT f.key, f.file, f.line, f.col ORDER BY f.key", ['--param', 'key=src/core/runtime/revive.ts#ReviveOptions']],
  ['Q5 boundary calls', "MATCH (caller:Declaration)-[call:CALLS]->(callee:Declaration) WHERE caller.top = 'src/commands' AND callee.top = 'src/daemon' RETURN caller.key, callee.key, call.line, call.col ORDER BY caller.key, callee.key, call.line UNION MATCH (caller:Declaration)-[call:CALLS]->(ext:External) WHERE caller.top = 'src/api' AND ext.module <> 'lib' RETURN caller.key, ext.key AS callee, call.line, call.col ORDER BY caller.key, callee, call.line", []],
  ['Q6 changed symbols and callers', 'UNWIND $commits AS hash MATCH (c:Commit)-[:CHANGED]->(d:Declaration) WHERE c.hash = hash WITH DISTINCT d OPTIONAL MATCH (caller:Declaration)-[:CALLS]->(d) RETURN d.key, coalesce(collect(DISTINCT caller.key), []) AS callers ORDER BY d.key', ['--since', 'HEAD~200']],
  ['Q7 functions without callers', "MATCH (f:Declaration) WHERE f.kind IN ['function','method'] AND NOT EXISTS { MATCH (:Declaration)-[:CALLS]->(f) } RETURN f.key, f.file, f.line, f.col ORDER BY f.key", []],
  ['RENAMED_FROM inferred continuity', 'MATCH (d:Declaration)-[r:RENAMED_FROM]->(c:Commit) RETURN d.key, r.oldKey, r.basis, c.hash ORDER BY c.hash, d.key', ['--since', 'HEAD~200']],
  ['Inbound traversal', 'MATCH (caller:Declaration)-[:CALLS*1..3]->(hub:Declaration) WHERE hub.key = $key RETURN DISTINCT caller.key ORDER BY caller.key', ['--param', 'key=src/core/runtime/revive.ts#reviveNode']],
  ['Outbound traversal', 'MATCH (hub:Declaration)-[:CALLS*1..5]->(callee:Declaration) WHERE hub.key = $key RETURN DISTINCT callee.key ORDER BY callee.key', ['--param', 'key=src/core/runtime/revive.ts#reviveNode']],
] as const;

const cli = path.resolve('dist/cli.js');
const sections: string[] = [];
let failures = 0;
try {
  for (const [name, cypher, flags] of queries) {
    const result = spawnSync(process.execPath, [cli, '--root', root, 'query', cypher, ...flags], { cwd: root, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache }, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    const rows = /<query\b[^>]*\brows="(\d+)"/.exec(result.stdout)?.[1] ?? 'unavailable';
    const requiresRows = name === 'Q6 changed symbols and callers' || name === 'RENAMED_FROM inferred continuity';
    const ok = (result.status === 0 || result.status === 1) && (!requiresRows || Number(rows) > 0);
    if (!ok) failures++;
    sections.push(`## ${name} — ${ok ? 'recorded' : 'FAILED'}\n\nRows: ${rows}. Exit: ${result.status}.${requiresRows ? ' Non-zero rows required.' : ''}\n\nQuery:\n\n\`\`\`cypher\n${cypher}\n\`\`\`\n\nCommand: \`tsym --root ${root} query <statement> ${flags.join(' ')}\`\n\n\`\`\`text\n${result.stdout}${result.stderr}\n\`\`\``);
  }
  writeFileSync(report, `# Query validation\n\nWorkspace: ${root}. Query row counts are the recorded baseline from this index.\n\n${sections.join('\n\n')}\n`);
  process.stdout.write(`${report}: ${failures} failed query runs\n`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  const stopped = spawnSync(process.execPath, [cli, '--root', root, 'server', 'stop'], { cwd: root, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache }, timeout: 60_000 });
  if (stopped.status === 0) rmSync(temporary, { recursive: true, force: true });
  else {
    process.stderr.write(`Could not stop the private query server; retained ${temporary}.\n${stopped.stderr}`);
    process.exitCode = 1;
  }
}
