import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = process.argv[2];
const report = path.resolve(process.argv[3] ?? 'crouter-validation.md');
if (!root || !path.isAbsolute(root) || !existsSync(path.join(root, 'package.json'))) throw new Error('Usage: npm run validate:crouter -- /absolute/crouter/root [/absolute/report.md]');
const scratch = path.join(os.homedir(), '.crouter/canvas/scratch');
mkdirSync(scratch, { recursive: true });
const temporary = mkdtempSync(path.join(scratch, 'symval-'));
const cache = path.join(temporary, 'cache');
const cli = path.join(repo, 'dist/cli.js');
const roots = new Set<string>();
interface Run { command: string; stdout: string; stderr: string; code: number | null; wall: number; }
const runs: Run[] = [];
const sections: string[] = [];
let failed = 0;
function shell(cwd: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')}: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}
function run(args: string[], cwd = root!): Run {
  roots.add(cwd);
  const start = performance.now();
  const result = spawnSync(process.execPath, [cli, '--root', cwd, ...args], { cwd, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache }, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  const value = { command: `tsym --root ${JSON.stringify(cwd)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + (result.error ? `\n${result.error}` : ''), code: result.status, wall: Math.round(performance.now() - start) };
  runs.push(value);
  return value;
}
function attr(text: string, name: string): string { return new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] ?? ''; }
function rows(result: Run): string[] { return result.stdout.split('\n').filter((line) => /^\S+:\d+:\d+  /.test(line)); }
function count(result: Run): number { return rows(result).length; }
function relation(result: Run, name: string): string { return new RegExp(`<${name}\\b[^>]*>`).exec(result.stdout)?.[0] ?? ''; }
function ms(result: Run): number { return Number(/(\d+) ms/.exec(result.stderr)?.[1] ?? NaN); }
function addressRows(result: Run): string[] { return [...new Set([...result.stdout.matchAll(/([\w./-]+\.[cm]?[jt]sx?:\d+:\d+)/g)].map((match) => match[1]!))]; }
function sourceChecks(result: Run, cwd = root!): string {
  const addresses = addressRows(result);
  const details = addresses.map((address) => {
    const [, file, line, column] = /^(.*):(\d+):(\d+)$/.exec(address)!;
    const full = path.join(cwd, file!);
    if (!existsSync(full)) return `${address}: MISSING FILE`;
    if (line === '0') return `${address}: module exists`;
    const text = readFileSync(full, 'utf8').split('\n')[Number(line) - 1];
    if (text === undefined || Number(column) > text.length + 1) return `${address}: INVALID POSITION`;
    return `${address}: ${text.trim()}`;
  });
  return details.length ? details.join('\n') : 'No declaration addresses in this result; criterion-specific source evidence below.';
}
function criterion(id: string, ok: boolean, result: string, evidence: string, selected: Run[]): void {
  if (!ok) failed++;
  sections.push(`## ${id} — ${ok ? 'PASS' : 'FAIL'}\n\n${result}\n\nSource cross-check:\n\n\`\`\`text\n${evidence}\n\`\`\`\n\n${selected.map((item) => `- Command ${runs.indexOf(item) + 1}: \`${item.command}\`; exit ${item.code}; wall ${item.wall} ms; receipt: ${item.stderr.trim()}`).join('\n')}`);
}
function same(a: string[], b: string[]): boolean { return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
const revision = shell(root, 'git', ['rev-parse', 'HEAD']);
const dirty = shell(root, 'git', ['status', '--porcelain']);
const compiler = shell(root, process.execPath, ['-p', 'require("typescript/package.json").version']);
const header = `# Crouter validation\n\nCrouter revision: ${revision}. TypeScript: ${compiler}. Node: ${process.version}. tsym revision: ${shell(repo, 'git', ['rev-parse', 'HEAD'])}. Host: ${os.platform()} ${os.arch()}. Started: ${new Date().toISOString()}. Private cache: ${cache}.\n\nCrouter working tree: ${dirty ? `dirty; tracked changes included in reads and the disposable rename copy:\n\n\`\`\`\n${dirty}\n\`\`\`` : 'clean'}. Spec counts remain unchanged; failures report observed values, not revised expectations. Wall time includes CLI startup; receipt time is reported separately.\n`;
try {
  const cold = run(['outline', 'src/core/runtime/revive.ts']);
  const baseline = run(['server', 'status']);
  const warm = run(['outline', 'src/core/runtime/revive.ts']);
  const baselineMemory = Number(attr(baseline.stdout, 'memory'));
  const outlineLines = rows(warm);
  const positions = outlineLines.map((line) => Number(/:(\d+):/.exec(line)?.[1]));
  criterion('A1', warm.code === 0 && count(warm) === 15 && !/  alias  /.test(warm.stdout) && positions.every((line, index) => index === 0 || line >= positions[index - 1]!) && /launchRevive  \(288L\)/.test(warm.stdout), `${count(warm)} rows; launchRevive: ${outlineLines.find((line) => line.includes('launchRevive')) ?? 'missing'}. Expected 15 rows and 288L.`, sourceChecks(warm), [cold, warm]);
  const members = run(['outline', 'src/core/runtime/revive.ts', '--members']);
  const crons = run(['outline', 'src/core/canvas/crons.ts']);
  const cronsMembers = run(['outline', 'src/core/canvas/crons.ts', '--members']);
  criterion('A2', /ReviveResult  \(25L, 6 members\)/.test(warm.stdout) && rows(members).filter((line) => /  ReviveResult(?:\.|  )/.test(line)).length === 7 && count(crons) === 41 && count(cronsMembers) === 100, `ReviveResult expanded rows ${rows(members).filter((line) => /  ReviveResult(?:\.|  )/.test(line)).length}; crons ${count(crons)}/${count(cronsMembers)} rows (expected 41/100).`, sourceChecks(members) + '\n' + sourceChecks(crons), [members, crons, cronsMembers]);
  const directory = run(['outline', 'src/core/runtime']);
  const directoryExport = run(['outline', 'src/core/runtime', '--exported']);
  const deep = run(['outline', 'src/core/runtime', '--depth', '2', '--exported']);
  let containerMatch = true;
  const containerDetails: string[] = [];
  for (const match of directoryExport.stdout.matchAll(/^(.+?)  \(\d+ files?, (\d+) symbols\)$/gm)) {
    const drill = run(['outline', match[1]!, '--exported', ...(match[1]!.endsWith('/') ? ['--depth', '2'] : [])]);
    containerMatch &&= count(drill) === Number(match[2]);
    containerDetails.push(`${match[1]}: container ${match[2]}, drilled ${count(drill)}`);
  }
  criterion('A3', directory.code === 0 && count(directory) === 0 && /symbols\)/.test(directory.stdout) && count(deep) === 1499 && ms(deep) < 500 && containerMatch, `${count(deep)} exported declaration rows; ${ms(deep)} ms receipt/${deep.wall} ms wall (expected 1499/<500ms). Container counts ${containerMatch ? 'match' : 'differ from'} drill-down.`, containerDetails.join('\n') + '\n' + sourceChecks(deep), [directory, directoryExport, deep]);
  const whole = run(['outline', '--depth', '2', '--exported']);
  const after = run(['server', 'status']);
  const delta = Number(attr(after.stdout, 'memory')) - baselineMemory;
  criterion('A4', whole.code === 0 && Number(attr(whole.stdout, 'symbols')) === 4461 && Number(attr(whole.stdout, 'files')) === 771 && /88 not in program/.test(whole.stderr) && ms(whole) < 4000 && delta < 250 * 1024 * 1024, `${attr(whole.stdout, 'symbols')} exported symbols (${count(whole)} printed declaration rows)/${attr(whole.stdout, 'files')} files; ${whole.stderr.trim()}. RSS baseline ${baselineMemory}, after ${attr(after.stdout, 'memory')}, growth ${(delta / 1024 / 1024).toFixed(1)} MiB. Expected 4461/771, 88 not in program, <4s and <250MiB growth.`, 'src/commands/handlers/outline.ts uses navtree over scope.files, not withOpen. src/server/projects.ts owns initial project bootstrap opens. Runtime RSS is wrapper plus tsserver.\n' + sourceChecks(whole), [baseline, whole, after]);
  const functions = run(['outline', '--kind', 'function', 'src/core/runtime/revive.ts']);
  const limit = run(['outline', '--limit', '3', 'src/core/runtime/revive.ts']);
  const refsGraph = run(['inspect', 'reviveNode', '--graph', '--only', 'refs']);
  criterion('A5', count(functions) === 4 && rows(functions).every((line) => /  function  /.test(line)) && count(limit) === 3 && /limit 3/.test(limit.stderr) && refsGraph.code === 2 && /refs/.test(refsGraph.stderr), `${count(functions)} functions; ${count(limit)} capped rows; refs graph exit ${refsGraph.code}.`, sourceChecks(functions), [functions, limit, refsGraph]);
  const readme = run(['outline', 'README.md']);
  const nope = run(['outline', 'nope.ts']);
  criterion('A6', readme.code === 2 && readme.stdout.includes('code="not-in-program"') && nope.code === 2 && nope.stdout.includes('code="no-such-path"') && ![readme, nope].some((item) => (item.stdout + item.stderr).includes('at Object.ThrowNoProject')), `README exists=${existsSync(path.join(root, 'README.md'))}; nope exists=${existsSync(path.join(root, 'nope.ts'))}. Errors must distinguish existing non-program paths and missing paths.`, `README.md filesystem existence checked; nope.ts filesystem absence checked.`, [readme, nope]);
  const find = run(['find', 'reviveNode']);
  const anchor = rows(find).find((line) => line.startsWith('src/core/runtime/revive.ts:') && /  function  /.test(line))?.split('  ')[0];
  if (!anchor) throw new Error('find did not return a function reviveNode in src/core/runtime/revive.ts; cannot validate remaining anchored criteria.');
  const callers = run(['inspect', 'reviveNode', '--only', 'callers', '--each', '0']);
  const excluded = run(['inspect', 'reviveNode', '--only', 'callers', '--each', '0', '--exclude', '**/*.test.ts']);
  const allFiles = Number(attr(relation(callers, 'callers'), 'files'));
  const filteredFiles = Number(attr(relation(excluded, 'callers'), 'files'));
  criterion('A7', attr(relation(callers, 'callers'), 'count') === '28' && allFiles === 23 && allFiles - filteredFiles === 12 && /excluded/.test(excluded.stderr), `${count(callers)} callers/${allFiles} files; exclusion leaves ${count(excluded)}/${filteredFiles}, removes ${allFiles - filteredFiles} files. Expected 28/23 and 12 files removed.`, sourceChecks(callers) + '\nText candidates (not compiler caller counts):\n' + shell(root, 'rg', ['-n', '\\breviveNode\\s*\\(', 'src']), [callers, excluded]);
  const inspect = run(['inspect', 'reviveNode']);
  criterion('A8', /function reviveNode/.test(inspect.stdout) && attr(relation(inspect, 'refs'), 'count') === '90' && attr(relation(inspect, 'refs'), 'shown') === '10' && attr(relation(inspect, 'callers'), 'count') === '28' && attr(relation(inspect, 'callers'), 'files') === '23' && attr(relation(inspect, 'callers'), 'shown') === '10' && attr(relation(inspect, 'calls'), 'count') === '1' && /decideRevive/.test(inspect.stdout) && attr(relation(inspect, 'impl'), 'count') === '0' && ms(inspect) < 200, `${['refs', 'callers', 'calls', 'impl'].map((name) => relation(inspect, name)).join(' ')}; warm receipt ${ms(inspect)} ms, wall ${inspect.wall} ms.`, sourceChecks(inspect), [inspect]);
  const cappedRefs = run(['inspect', 'reviveNode', '--only', 'refs']);
  const allRefs = run(['inspect', 'reviveNode', '--only', 'refs', '--each', '0']);
  criterion('A8b', attr(relation(cappedRefs, 'refs'), 'count') === '90' && count(cappedRefs) === 10 && count(allRefs) === 90 && attr(relation(allRefs, 'refs'), 'shown') === '90' && cappedRefs.stderr.includes('--only refs --each 0'), `Capped ${count(cappedRefs)} rows/${attr(relation(cappedRefs, 'refs'), 'count')} total; uncapped ${count(allRefs)}. Expected 10/90 and 90.`, sourceChecks(allRefs), [cappedRefs, allRefs]);
  criterion('A9', count(find) === 3 && ['src/api/client.ts:419:3', 'src/core/runtime/revive.ts:222:23', 'src/index.ts:18:10'].every((address) => find.stdout.includes(address)), `find rows ${count(find)}; current canonical anchor ${anchor}. Recorded canonical anchor src/core/runtime/revive.ts:222:23. Exact source coordinates are compared, not rewritten.`, sourceChecks(find), [find]);
  const type = run(['type', 'reviveNode']);
  criterion('A10', type.code === 0 && type.stdout.includes('function reviveNode(nodeId: string, opts: ReviveOptions): Promise<ReviveResult>') && type.stdout.includes('kind="function" modifiers="export"') && type.stdout.includes("Relaunch `nodeId`'s broker engine from its persisted recipe and update canvas\nmeta. Opens no viewer (engine-only)."), `Signature matches=${type.stdout.includes('function reviveNode(nodeId: string, opts: ReviveOptions): Promise<ReviveResult>')}; modifiers match=${type.stdout.includes('kind="function" modifiers="export"')}; documentation prefix compared verbatim, including whitespace.`, readFileSync(path.join(root, 'src/core/runtime/revive.ts'), 'utf8').split('\n').slice(Number(anchor.split(':')[1]) - 12, Number(anchor.split(':')[1]) + 2).join('\n'), [type]);
  const grep = shell(root, 'rg', ['-n', 'reviveNode', 'src/commands']).split('\n');
  const first = grep[0]!;
  const usage = grep.find((line) => !/^\s*(\/\/|\*|\/\*)/.test(line.split(':').slice(2).join(':')) && /\breviveNode\b/.test(line.split(':').slice(2).join(':')))!;
  function grepAddress(line: string): string { const [file, number, ...text] = line.split(':'); return `${file}:${number}:${text.join(':').indexOf('reviveNode') + 2}`; }
  const firstType = run(['type', grepAddress(first)]);
  const usageType = usage === first ? firstType : run(['type', grepAddress(usage)]);
  criterion('A11', firstType.code === 0 && firstType.stdout.includes(`at="${anchor}"`), `First rg match: ${first}. First match result exit ${firstType.code}. ${usage === first ? 'No drift.' : `First match drifted; separate executable/import usage ${grepAddress(usage)} exits ${usageType.code}, resolves anchor=${usageType.stdout.includes(`at="${anchor}"`)}. The replacement does not make the original criterion pass.`}`, first + '\n' + usage + '\n' + sourceChecks(usageType), [firstType, ...(usage === first ? [] : [usageType])]);
  const status = run(['server', 'status']);
  const stop = run(['server', 'stop']);
  const stopped = run(['server', 'status']);
  const startup = Number(/server start[^\d]*(\d+)/.exec(cold.stderr)?.[1] ?? NaN);
  criterion('A12', startup >= 2000 && startup <= 4000 && !/server start/.test(warm.stderr) && ms(warm) < 200 && status.code === 0 && ['root', 'pid', 'tsserver', 'typescript', 'log'].every((name) => attr(status.stdout, name)) && stopped.code === 1, `Initial receipt start=${startup} ms; cold wall ${cold.wall}; warm receipt ${ms(warm)} ms. Status pid=${attr(status.stdout, 'pid')}, compiler=${attr(status.stdout, 'typescript')}, after stop exit=${stopped.code}.`, `Reported compiler path ${attr(status.stdout, 'tsserver')}; file exists=${existsSync(attr(status.stdout, 'tsserver'))}. No source edits involved.`, [cold, warm, status, stop, stopped]);
  const copy = path.join(temporary, 'rename-crouter');
  mkdirSync(copy);
  for (const file of shell(root, 'git', ['ls-files', '-z']).split('\0').filter(Boolean)) {
    if (!existsSync(path.join(root, file))) continue;
    mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    cpSync(path.join(root, file), path.join(copy, file), { recursive: true });
  }
  symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  shell(copy, 'git', ['init', '-q']);
  shell(copy, 'git', ['add', '.']);
  shell(copy, 'git', ['-c', 'user.name=tsym validation', '-c', 'user.email=validation@localhost', 'commit', '-qm', 'validation baseline']);
  const preview = run(['rename', 'reviveNode', 'relaunchNode'], copy);
  const previewClean = shell(copy, 'git', ['status', '--porcelain']) === '';
  const files = [...preview.stdout.matchAll(/<file path="([^"]+)"/g)].map((match) => match[1]!);
  const apply = run(['rename', 'reviveNode', 'relaunchNode', '--apply'], copy);
  const changed = shell(copy, 'git', ['diff', '--name-only']).split('\n').filter(Boolean);
  const filteredApply = run(['rename', 'relaunchNode', 'reviveNode', '--apply', '--in', 'src/core'], copy);
  criterion('A13', preview.code === 0 && preview.stdout.includes('applied="false"') && previewClean && files.length > 1 && apply.code === 0 && apply.stdout.includes('applied="true"') && same(files, changed) && filteredApply.code === 2, `Disposable copy ${copy}; preview ${files.length} files; preview clean=${previewClean}; actual diff ${changed.length} files; sets equal=${same(files, changed)}. No live checkout writes.`, `git diff --name-only:\n${changed.join('\n')}\n` + shell(copy, 'git', ['diff', '--stat']), [preview, apply, filteredApply]);
  run(['server', 'stop'], copy);
  run(['outline', 'src/core/runtime/revive.ts']);
  const fileCheck = run(['check', 'src/core/runtime/revive.ts']);
  const programCheck = run(['check']);
  criterion('A14', fileCheck.code === 1 && ms(fileCheck) < 200 && (programCheck.code === 0 || programCheck.code === 1) && ms(programCheck) >= 1000 && ms(programCheck) <= 3000, `File check exit ${fileCheck.code}, receipt ${ms(fileCheck)} ms/wall ${fileCheck.wall}; program check exit ${programCheck.code}, receipt ${ms(programCheck)} ms/wall ${programCheck.wall}. TS7 whole-program range: 1,000–3,000 ms.`, sourceChecks(fileCheck) + '\n' + sourceChecks(programCheck), [fileCheck, programCheck]);
  const graph = run(['inspect', 'reviveNode', '--only', 'calls', '--depth', '3', '--graph']);
  const graphAddresses = addressRows(graph);
  const shows = graphAddresses.map((address) => run(['show', address]));
  const merged = run(['inspect', 'reviveNode', 'decideRevive', '--only', 'calls', '--depth', '3', '--graph']);
  criterion('A15', graph.code === 0 && graphAddresses.length > 0 && shows.every((item) => item.code === 0) && (merged.stdout.match(/flowchart TD/g) ?? []).length === 1, `${graphAddresses.length} graph addresses; ${shows.filter((item) => item.code === 0).length} accepted by show; multi-seed flowcharts ${(merged.stdout.match(/flowchart TD/g) ?? []).length}.`, sourceChecks(graph), [graph, ...shows, merged]);
  const helps = [[], ['outline'], ['inspect'], ['server']].map((args) => run([...args, '-h']));
  const wrongLimit = run(['inspect', 'reviveNode', '--limit', '5']);
  criterion('A16', helps.every((item) => item.code === 0) && new Set(helps.map((item) => item.stdout)).size === 4 && !helps[0]!.stdout.includes('<input>') && /<server\b[^>]*state="(?:ready|stopped)"/.test(helps[0]!.stdout) && wrongLimit.code === 2 && wrongLimit.stdout.includes('--each'), `Four distinct help documents; root input schema absent=${!helps[0]!.stdout.includes('<input>')}; wrong limit exit ${wrongLimit.code}.`, 'src/commands/tree.ts owns per-node declarations; src/commands/help.ts emits selected node only. Root server state read from status.', [...helps, wrongLimit]);
  const grepMorph = spawnSync('rg', ['ts-morph', 'src', 'test', 'package.json'], { cwd: repo, encoding: 'utf8' });
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  criterion('A17', grepMorph.status === 1 && !pkg.dependencies['ts-morph'], `rg ts-morph src test package.json exit ${grepMorph.status}; dependency absent=${!pkg.dependencies['ts-morph']}. Published tarball verified separately in package-delivery report.`, `package.json dependencies: ${Object.keys(pkg.dependencies).join(', ')}; grep output: ${grepMorph.stdout || '(empty)'}`, []);
  const fixture = path.join(temporary, 'fixture');
  cpSync(path.join(repo, 'test/fixture'), fixture, { recursive: true });
  const fixtureFind = run(['find', 'deliver'], fixture);
  const deliver = rows(fixtureFind)[0]?.split('  ')[0];
  if (!deliver) throw new Error('Fixture deliver declaration not found.');
  const d1 = run(['inspect', deliver, '--only', 'calls', '--depth', '1', '--each', '0'], fixture);
  const d2 = run(['inspect', deliver, '--only', 'calls', '--depth', '2', '--each', '0'], fixture);
  const dg = run(['inspect', deliver, '--only', 'calls', '--depth', '2', '--graph'], fixture);
  const fixtureShows = addressRows(dg).map((address) => run(['show', address], fixture));
  const sends = rows(d1).map((line) => line.split('  ')[0]!);
  const incoming = sends.map((address) => run(['inspect', address, '--only', 'callers', '--each', '0'], fixture));
  const missing = run(['inspect', 'missing', '--only', 'calls', '--graph'], fixture);
  const projected = run(['inspect', deliver, '--only', 'calls', '--depth', '2', '--in', 'src/inspect-dispatch.ts', '--each', '0'], fixture);
  const removed = run(['inspect', deliver, '--only', 'calls', '--depth', '2', '--exclude', 'src/inspect-dispatch.ts', '--each', '0'], fixture);
  criterion('A18', count(d1) === 2 && rows(d1).every((line) => /  1  .*impl/.test(line)) && /1 dispatch/.test(d1.stderr) && !/unresolved/.test(d1.stderr) && count(d2) === 4 && dg.stdout.includes('-.->|impl|') && fixtureShows.every((item) => item.code === 0) && incoming.every((item) => item.stdout.includes('deliver') && item.stdout.includes('impl')) && /1 unresolved, 1 dispatch/.test(missing.stderr) && missing.stdout.includes('unresolved_dispatch') && count(projected) === 4 && count(removed) === 0, `Depth 1=${count(d1)}, depth 2=${count(d2)}; ${fixtureShows.length} graph addresses shown; incoming traversals ${incoming.length}; projected=${count(projected)}, excluded=${count(removed)}. A18 fixture is checked in verbatim.`, sourceChecks(d2, fixture) + '\n' + readFileSync(path.join(fixture, 'src/inspect-dispatch.ts'), 'utf8'), [fixtureFind, d1, d2, dg, ...fixtureShows, ...incoming, missing, projected, removed]);
} catch (error) {
  failed++;
  sections.push(`## Validation interrupted — FAIL\n\n${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const cwd of roots) run(['server', 'stop'], cwd);
  const transcript = runs.map((item, index) => `## Command ${index + 1}\n\n\`${item.command}\`\n\nExit ${item.code}; wall ${item.wall} ms.\n\n\`\`\`text\n${item.stdout}\n${item.stderr}\n\`\`\``).join('\n\n');
  writeFileSync(report, `${header}\nFailed criteria/checks: ${failed}.\n\n${sections.join('\n\n')}\n\n# Full command transcript\n\n${transcript}\n`);
  rmSync(temporary, { recursive: true, force: true });
  process.stdout.write(`${report}: ${failed} failed criteria/checks\n`);
  process.exitCode = failed ? 1 : 0;
}
