import { parseArgs } from 'node:util';
import { renderGraph } from './core/render-graph.js';
import { formatReceipt } from './core/receipt.js';
import { AmbiguousSymbol, EmptySymbolList, SymbolNotFound } from './core/symbols.js';
import { SYMBOL_KINDS, type Callee, type Caller, type Excerpt, type Loc, type Match, type Receipt, type Ref, type Result, type Symbol, type SymbolKind } from './core/types.js';
import { NoProject } from './core/workspace.js';
import { openWorkspace } from './index.js';

const USAGE = `ast — symbol-level reading of a codebase (TypeScript/JavaScript)

Usage: ast <command> <arg> [options]

Commands
  outline <file>                 symbols declared in one file (top-level and members)
  find <name> [--kind K]         where a symbol is declared; <name> may be Outer.member or a glob like handle*
  show <symbol> [--numbers]      source of one declaration, with its doc comment
  search <pattern>               structural pattern match; $A matches one node, $$$ARGS a sequence
  refs <symbol>...               every reference site (declarations excluded); writes marked
  callers <symbol>...            functions/methods that call them, one row per caller
  calls <symbol>...              functions/methods/constructors they call, one row per callee
  impact <symbol>... [--depth N] transitive callers up to N levels (default 3), plus re-exports
  trace <symbol>... [--depth N]  transitive callees up to N levels (default 3)

<symbol> is a name (reviveNode), a member (Broker.start), or a position (src/a.ts:41:17) as printed by
find, grep, or any ast command — so results chain: ast find Foo | cut -d: -f1-3 | xargs ast refs.
An ambiguous name fails and lists the candidates; --path FILE picks one.

Output (stdout)
  default      path:line:col: text            grep-compatible
  --paths      unique paths, one per line
  --ranges     path:start-end, one per item
  --json       { items, graph, receipt } for trace/impact; { items, receipt } otherwise
  --graph      Mermaid flowchart for trace/impact
Every run prints a one-line receipt on stderr: items, files matched, files scanned, engine, elapsed.
Only --limit N truncates a result. Exit 0 with items, 1 with none, 2 on a bad symbol or usage.

Options
  --in GLOB      keep only rows under matching paths (repeatable; all commands; on trace/impact the graph keeps the connecting path)
  --exclude GLOB remove matching paths and whatever is only reachable through them (repeatable; all commands; wins over --in)
  --kind KIND    ${SYMBOL_KINDS.join(' | ')}
  --path FILE    resolve a symbol name inside one file
  --depth N      impact/trace: levels of callers/callees to follow (default 3)
  --graph        trace/impact: render a Mermaid flowchart
  --limit N      stop after N items (sets truncated in the receipt)
  --numbers      show: prefix each source line with its line number
  --cwd DIR      resolve the workspace from DIR instead of the current directory
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      paths: { type: 'boolean', default: false },
      ranges: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      graph: { type: 'boolean', default: false },
      numbers: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      in: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      kind: { type: 'string' },
      path: { type: 'string' },
      depth: { type: 'string' },
      limit: { type: 'string' },
      cwd: { type: 'string' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  if (args.length === 0) return usageError(`${command} needs an argument`);
  const multiSeed = command === 'refs' || command === 'callers' || command === 'calls' || command === 'impact' || command === 'trace';
  if (!multiSeed && args.length > 1) return usageError(`${command} takes one argument`);
  const arg = args[0]!;
  if (values.graph && command !== 'trace' && command !== 'impact') return usageError(`--graph is only valid with trace or impact`);
  if (values.graph && (values.json || values.paths || values.ranges)) return usageError(`--graph cannot be combined with another output mode`);
  if (values.kind && !SYMBOL_KINDS.includes(values.kind as SymbolKind)) return usageError(`--kind must be one of ${SYMBOL_KINDS.join(', ')}`);
  const limit = values.limit ? Number(values.limit) : null;
  const depth = values.depth ? Number(values.depth) : undefined;
  const ast = openWorkspace(values.cwd);
  const filters = { in: values.in, exclude: values.exclude };
  const mode = values.graph ? 'graph' : values.json ? 'json' : values.paths ? 'paths' : values.ranges ? 'ranges' : 'lines';

  let result: Result<Loc>;
  let lines: string[];
  switch (command) {
    case 'outline': {
      const r = ast.outline(arg, filters);
      result = r;
      lines = r.items.map(symbolLine);
      break;
    }
    case 'find': {
      const r = await ast.find(arg, { kind: values.kind as SymbolKind | undefined, limit, ...filters });
      result = r;
      lines = r.items.map(symbolLine);
      break;
    }
    case 'show': {
      const r = await ast.show(arg, { path: values.path, ...filters });
      result = r;
      lines = r.items.flatMap((e) => excerptLines(e, values.numbers));
      break;
    }
    case 'search': {
      const r = await ast.search(arg, { limit, ...filters });
      result = r;
      lines = r.items.map(matchLine);
      break;
    }
    case 'refs': {
      const r = await ast.refs(args, { path: values.path, limit, ...filters });
      result = r;
      lines = r.items.map(refLine);
      break;
    }
    case 'callers': {
      const r = await ast.callers(args, { path: values.path, limit, ...filters });
      result = r;
      lines = r.items.map((c) => callerLine(c, false));
      break;
    }
    case 'calls': {
      const r = await ast.calls(args, { path: values.path, limit, ...filters });
      result = r;
      lines = r.items.map((c) => calleeLine(c, false));
      break;
    }
    case 'impact': {
      const r = await ast.impact(args, { path: values.path, depth, limit, ...filters });
      result = r;
      lines = r.items.map((c) => callerLine(c, true));
      break;
    }
    case 'trace': {
      const r = await ast.trace(args, { path: values.path, depth, limit, ...filters });
      result = r;
      lines = r.items.map((c) => calleeLine(c, true));
      break;
    }
    default:
      return usageError(`unknown command: ${command}`);
  }

  emit(result, lines, mode);
  return result.items.length > 0 ? 0 : 1;
}

function emit(result: Result<Loc>, lines: string[], mode: 'json' | 'paths' | 'ranges' | 'lines' | 'graph'): void {
  let out: string;
  switch (mode) {
    case 'json':
      out = JSON.stringify(result, null, 2) + '\n';
      break;
    case 'paths':
      out = [...new Set(result.items.map((i) => i.path))].map((p) => p + '\n').join('');
      break;
    case 'ranges':
      out = result.items.map((i) => `${i.path}:${i.start.line}-${i.end.line}\n`).join('');
      break;
    case 'lines':
      out = lines.map((l) => l + '\n').join('');
      break;
    case 'graph':
      out = renderGraph(result.graph ?? { nodes: [], edges: [], unresolved: [] });
      break;
  }
  process.stdout.write(out);
  if (mode !== 'json') process.stderr.write(formatReceipt(result.receipt as Receipt) + '\n');
}

function symbolLine(s: Symbol): string {
  return `${s.path}:${s.namePos.line}:${s.namePos.col}: ${s.kind} ${s.qualifiedName}  ${s.text}`;
}

function excerptLines(e: Excerpt, numbers: boolean): string[] {
  const src = e.source.split('\n');
  if (!numbers) return src;
  const width = String(e.end.line).length;
  return src.map((l, i) => `${String(e.start.line + i).padStart(width)}: ${l}`);
}

function matchLine(m: Match): string {
  return `${m.path}:${m.start.line}:${m.start.col}: ${m.text}`;
}

function refLine(r: Ref): string {
  return `${r.path}:${r.start.line}:${r.start.col}: ${r.text}${r.write ? '  (write)' : ''}`;
}

function callerLine(c: Caller, withDepth: boolean): string {
  const extra = [withDepth ? `depth ${c.depth}` : null, c.callSites > 1 ? `${c.callSites} call sites` : null].filter(Boolean).join(', ');
  return `${c.path}:${c.start.line}:${c.start.col}: ${c.kind} ${c.qualifiedName}  ${c.text}${extra ? `  [${extra}]` : ''}`;
}

function calleeLine(c: Callee, withDepth: boolean): string {
  const extra = [withDepth ? `depth ${c.depth}` : null, c.callSites > 1 ? `${c.callSites} call sites` : null].filter(Boolean).join(', ');
  return `${c.path}:${c.start.line}:${c.start.col}: ${c.kind} ${c.qualifiedName}  ${c.text}${extra ? `  [${extra}]` : ''}`;
}

function usageError(msg: string): number {
  process.stderr.write(`ast: ${msg}\nRun ast --help for usage.\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof AmbiguousSymbol || err instanceof EmptySymbolList || err instanceof SymbolNotFound || err instanceof NoProject) {
      process.stderr.write(`ast: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`ast: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  },
);
