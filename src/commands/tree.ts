import type { CommandDeclaration, Constraint, FlagDeclaration, Invocation, InvocationError, ParsedInput, ValidationProblem } from './types.js';

const kinds = ['function', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var', 'method', 'property', 'getter', 'setter', 'constructor', 'module'] as const;
const relations = ['refs', 'callers', 'calls', 'impl'] as const;
const filters: readonly FlagDeclaration[] = [
  { name: '--in', type: 'glob', repeat: true, description: 'Keep only rows under matching paths.' },
  { name: '--exclude', type: 'glob', repeat: true, description: 'Drop matching paths. Wins over --in.' },
];

const selectedTraversal: Constraint = {
  check(input) {
    const only = (input.flags['--only'] as string[] | undefined) ?? [...relations];
    const traverses = only.some((value) => value === 'callers' || value === 'calls');
    const problems: ValidationProblem[] = [];
    if (input.explicit.has('--depth') && !traverses) problems.push({ field: '--depth', received: only.join(', '), expected: 'at least one of callers or calls', next: 'Omit --depth or select callers or calls.' });
    if (input.explicit.has('--graph') && !traverses) problems.push({ field: '--graph', received: only.join(', '), expected: 'at least one of callers or calls, because refs and impl produce no edges to draw', next: 'Omit --graph or select callers or calls.' });
    if (input.explicit.has('--each') && input.flags['--graph'] === true) problems.push({ field: '--each', received: String(input.flags['--each']), expected: 'not used with --graph', next: 'Omit --each; graphs are never capped.' });
    return problems;
  },
};

const renameApplyFilters: Constraint = {
  check(input) {
    if (input.flags['--apply'] === true && (input.explicit.has('--in') || input.explicit.has('--exclude'))) return [{ field: '--apply', received: '--apply with a path filter', expected: '--apply without --in or --exclude', next: 'Preview a filtered rename without --apply, or apply the complete rename.' }];
    return [];
  },
};

const renameIdentifier: Constraint = {
  check(input) {
    const name = input.args[1];
    if (input.args.length !== 2 || !name || identifier.test(name) && !keywords.has(name)) return [];
    return [{ field: '<newName>', received: name, expected: 'a TypeScript identifier that is not a reserved keyword', next: 'Choose a valid replacement identifier, then retry rename.' }];
  },
};

const identifier = /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u;
const keywords = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);

function leaf(name: string, description: string, whenToUse: string, handler: CommandDeclaration['handler'], argument: CommandDeclaration['argument'], flags: readonly FlagDeclaration[], output: string, effects = 'None.'): CommandDeclaration {
  return { name, description, whenToUse, handler, argument, flags, output, effects };
}

export const commandTree: CommandDeclaration = {
  name: 'symbols',
  description: 'Symbol-level reading of a TypeScript codebase, from the compiler\'s own resolution.',
  model: 'Every answer comes from a loaded TypeScript program, not text matching. Start at outline and drill into declarations. Every printed path:line:col address is accepted by every symbol command, including a usage address. A resident server starts when a semantic command needs it and exits after idle time.',
  children: [
    leaf('outline', 'Structure of a file, a directory, or the whole repository.', 'Reach for this first when you need the shape of unfamiliar code before reading declarations.', 'outline', { name: 'path', repeat: '0+', description: 'File, directory, or glob. Default: the workspace root.' }, [{ name: '--depth', type: 'int', default: 1, minimum: 1, description: 'Levels to descend.' }, { name: '--kind', type: 'string', repeat: true, values: kinds, description: `Keep only these kinds: ${kinds.join(', ')}.` }, { name: '--exported', type: 'bool', description: 'Keep only exported declarations.' }, { name: '--members', type: 'bool', description: 'Expand members on reached owners.' }, { name: '--imports', type: 'bool', description: 'Include import aliases.' }, ...filters, { name: '--limit', type: 'int', minimum: 0, description: 'Cap rows.' }], 'One <outline> element. Symbol rows are ordered by source position; container counts are computed after filters.'),
    leaf('find', 'Locate a declaration by name.', 'Reach for this when you know a declaration name and need its canonical address.', 'find', { name: 'name', repeat: '1', description: 'Declared name. Container.name narrows to a member.' }, [{ name: '--prefix', type: 'bool', description: 'Match names beginning with the input.' }, { name: '--kind', type: 'string', repeat: true, values: kinds, description: 'Keep only these kinds.' }, ...filters, { name: '--limit', type: 'int', minimum: 0, description: 'Cap rows.' }], 'One <find> element with rows ordered by path and position.'),
    leaf('show', 'The declaration\'s source text.', 'Reach for this to read one declaration in full without reading its file.', 'show', { name: 'symbol', repeat: '1+', description: 'path:line:col, or a name. A usage address resolves to its declaration first.' }, [{ name: '--limit', type: 'int', minimum: 0, description: 'Cap how many declarations are printed.' }], 'One <show> element with a <symbol> element per argument, in argument order.'),
    leaf('type', 'Resolved type, signature, and doc comment.', 'Reach for this when source text does not answer the compiler-resolved type.', 'type', { name: 'symbol', repeat: '1+', description: 'path:line:col, or a name. A usage address resolves to its declaration first.' }, [{ name: '--def', type: 'bool', description: 'Also resolve the declaration of the type.' }], 'One <type> element with a <symbol> element per argument.', 'Opens and closes a document in the server. No persistent change.'),
    { ...leaf('inspect', 'How a symbol relates to the rest of the code.', 'Reach for this for references, callers, calls, or implementations; all four run by default.', 'inspect', { name: 'symbol', repeat: '1+', description: 'path:line:col, or a name. Each symbol gets its own result block.' }, [{ name: '--only', type: 'string', repeat: true, values: relations, description: `Run only these relations: ${relations.join(', ')}. Default: all four.` }, { name: '--each', type: 'int', default: 10, minimum: 0, description: 'Rows per relation. Use 0 for every row.' }, { name: '--depth', type: 'int', default: 1, minimum: 1, description: 'Levels to follow for callers and calls.' }, { name: '--graph', type: 'bool', description: 'Render callers and calls as one Mermaid graph.' }, ...filters], 'One <inspect> element per symbol, or one graph for all seeds. Counts are true totals; --each caps display only.', 'None.'), constraints: [selectedTraversal] }, 
    leaf('search', 'Structural syntax search over the source.', 'Reach for this when the pattern is syntax shape rather than a named symbol.', 'search', { name: 'pattern', repeat: '1', description: 'An ast-grep pattern. $NAME captures a node; $$$NAME captures a list.' }, [{ name: '--lang', type: 'string', default: 'ts', values: ['ts', 'tsx', 'js', 'jsx'], description: 'Parser language: ts, tsx, js, or jsx. tsx is selected automatically for .tsx files.' }, ...filters, { name: '--limit', type: 'int', minimum: 0, description: 'Cap rows.' }], 'One <search> element with deterministic match rows.'),
    leaf('check', 'Semantic and syntactic diagnostics.', 'Reach for this after editing to check changed files or the complete program.', 'check', { name: 'path', repeat: '0+', description: 'Files or globs. Default: the whole program.' }, [{ name: '--errors-only', type: 'bool', description: 'Drop warnings and suggestions.' }, ...filters, { name: '--limit', type: 'int', minimum: 0, description: 'Cap diagnostics.' }], 'One <check> element with ordered diagnostics.', 'Opens and closes documents. No persistent change.'),
    { ...leaf('rename', 'Rename a symbol across the program.', 'Reach for this instead of editing call sites by hand when a rename crosses files.', 'rename', { name: 'symbol and newName', repeat: '1+', description: 'Exactly two values: path:line:col or a name, then the replacement identifier. A usage address resolves to its declaration first.' }, [{ name: '--apply', type: 'bool', description: 'Write the complete compiler-provided edit plan. Rejected with path filters.' }, ...filters], 'One <rename> element with one <file> per affected file. Each row is line:col  old → new; applied says whether writes completed.', 'Without --apply: none. With --apply: every planned file is rewritten, all or none for failures observed by this process.'), constraints: [renameApplyFilters, renameIdentifier] },
    {
      name: 'server', description: 'The resident TypeScript process.', whenToUse: 'Reach for this only when the server is wrong rather than absent, such as after a branch switch or dependency install.',
      model: 'One server per workspace root holds a loaded program. Ordinary file edits need nothing; reload is for changes to program shape.',
      state: () => null,
      children: [
        leaf('status', 'Whether a server is live, and what it is running.', 'Reach for this after an unexpected failure or slow command to read server identity and log path.', 'server-status', undefined, [], 'One <server> element. A stopped server is an answered empty result.'),
        leaf('stop', 'Stop the server for this root.', 'Reach for this to free resident memory or recover a server.', 'server-stop', undefined, [], 'One <server> element describing whether a process stopped.', 'Stops the resident process; it never starts one.'),
        leaf('reload', 'Restart the server, discarding the loaded program.', 'Reach for this after a branch switch, tsconfig change, or dependency install.', 'server-reload', undefined, [], 'One <server> element for the fresh ready process.', 'Stops then starts the resident process.'),
      ],
    },
  ],
};

const globals: readonly FlagDeclaration[] = [
  { name: '--root', type: 'path', description: 'Workspace root, overriding discovery from the current directory.' },
  { name: '--json', type: 'bool', description: 'Raw JSON on stdout for programmatic consumers.' },
];

export function findNode(tokens: readonly string[]): { node: CommandDeclaration; consumed: number } {
  let node = commandTree;
  let consumed = 0;
  while (node.children?.length && tokens[consumed]) {
    const child = node.children.find((candidate) => candidate.name === tokens[consumed]);
    if (!child) break;
    node = child;
    consumed++;
  }
  return { node, consumed };
}

export function parseInvocation(argv: readonly string[]): Invocation | InvocationError | { help: CommandDeclaration } {
  const helpIndex = argv.findIndex((token) => token === '-h' || token === '--help');
  const withoutHelp = helpIndex >= 0 ? [...argv.slice(0, helpIndex), ...argv.slice(helpIndex + 1)] : [...argv];
  const { tokens: noHelp, commandTokens } = normalizeGlobals(withoutHelp);
  const pathTokens: string[] = [];
  for (const token of commandTokens) {
    if (token === '--' || token.startsWith('-')) break;
    pathTokens.push(token);
  }
  const { node, consumed } = findNode(pathTokens);
  if (helpIndex >= 0) return { help: node };
  if (node.children && consumed < pathTokens.length) return invalid(node, [{ field: 'command', received: pathTokens[consumed]!, expected: `one of ${node.children.map((child) => child.name).join(', ')}`, next: `Run symbols ${node.name === 'symbols' ? '' : node.name + ' '}-h and read the command tree.` }]);
  const parsed = parseArgs(noHelp.slice(consumed), node);
  if (node.children && consumed === pathTokens.length && parsed.problems.length === 0 && parsed.input.args.length === 0) return { help: node };
  const root = parsed.input.flags['--root'] as string | undefined;
  const json = parsed.input.flags['--json'] === true;
  const constraintProblems = (node.constraints ?? []).flatMap((constraint) => constraint.check(parsed.input));
  if (parsed.problems.length > 0 || constraintProblems.length > 0) return invalid(node, [...parsed.problems, ...constraintProblems]);
  return { root, json, path: noHelp.slice(0, consumed), declaration: node, input: parsed.input };
}

function parseArgs(tokens: readonly string[], node: CommandDeclaration): { input: ParsedInput; problems: ValidationProblem[] } {
  const flags = new Map<string, FlagDeclaration>([...globals, ...(node.flags ?? [])].map((flag) => [flag.name, flag]));
  const values: ParsedInput['flags'] = {};
  const explicit = new Set<string>();
  for (const declaration of flags.values()) if (declaration.default !== undefined) values[declaration.name] = declaration.default;
  const args: string[] = [];
  const problems: ValidationProblem[] = [];
  let positional = true;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--') { positional = false; continue; }
    if (positional && token.startsWith('-') && token !== '-') {
      const [name, inline] = token.split('=', 2);
      const declaration = flags.get(name);
      if (!declaration) { problems.push({ field: name, received: token, expected: `a declared flag for symbols ${[...nodePath(node), node.name].filter(Boolean).join(' ')}`, next: helpNext(node) }); continue; }
      const duplicated = explicit.has(name) && !declaration.repeat;
      explicit.add(name);
      if (declaration.type === 'bool') {
        if (duplicated) problems.push({ field: name, received: token, expected: 'one occurrence; this flag is not repeatable', next: helpNext(node) });
        if (inline !== undefined) problems.push({ field: name, received: token, expected: 'a boolean flag with no value', next: helpNext(node) });
        else values[name] = true;
        continue;
      }
      const raw = inline ?? tokens[++index];
      if (raw === undefined) { problems.push({ field: name, received: token, expected: `${declaration.type} value`, next: helpNext(node) }); continue; }
      const value = parseValue(raw, declaration, problems, node);
      if (value === undefined) continue;
      if (declaration.repeat) values[name] = [...((values[name] as string[] | undefined) ?? []), String(value)];
      else if (duplicated) problems.push({ field: name, received: raw, expected: 'one value; this flag is not repeatable', next: helpNext(node) });
      else values[name] = value;
    } else args.push(token);
  }
  const argument = node.argument;
  if (argument) {
    const invalidCount = (argument.repeat === '1' && args.length !== 1) || (argument.repeat === '1+' && args.length < 1);
    if (invalidCount) problems.push({ field: `<${argument.name}>`, received: args.length === 0 ? 'none' : args.join(' '), expected: argument.repeat === '1' ? 'exactly one value' : 'one or more values', next: helpNext(node) });
    if (node.name === 'rename' && args.length !== 2) problems.push({ field: '<symbol> <newName>', received: args.join(' ') || 'none', expected: 'exactly two values', next: helpNext(node) });
  } else if (args.length > 0) problems.push({ field: 'arguments', received: args.join(' '), expected: 'no positional arguments', next: helpNext(node) });
  return { input: { args, flags: values, explicit }, problems };
}

function parseValue(raw: string, declaration: FlagDeclaration, problems: ValidationProblem[], node: CommandDeclaration): boolean | number | string | undefined {
  if (declaration.type === 'int') {
    if (!/^-?\d+$/.test(raw)) { problems.push({ field: declaration.name, received: raw, expected: 'an integer', next: helpNext(node) }); return undefined; }
    const value = Number(raw);
    if (declaration.minimum !== undefined && value < declaration.minimum) { problems.push({ field: declaration.name, received: raw, expected: `an integer at least ${declaration.minimum}`, next: helpNext(node) }); return undefined; }
    return value;
  }
  if (declaration.values && !declaration.values.includes(raw)) { problems.push({ field: declaration.name, received: raw, expected: `one of ${declaration.values.join(', ')}`, next: helpNext(node) }); return undefined; }
  return raw;
}

function normalizeGlobals(tokens: readonly string[]): { tokens: string[]; commandTokens: string[] } {
  const commandTokens: string[] = [];
  const globals: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--json') { globals.push(token); continue; }
    if (token === '--root') { globals.push(token); if (tokens[index + 1] !== undefined) globals.push(tokens[++index]!); continue; }
    if (token.startsWith('--root=')) { globals.push(token); continue; }
    commandTokens.push(token);
  }
  return { tokens: [...commandTokens, ...globals], commandTokens };
}

function nodePath(node: CommandDeclaration): string[] { return node === commandTree ? [] : []; }
function helpNext(node: CommandDeclaration): string { return `Run \`symbols ${node.name === 'symbols' ? '' : node.name + ' '}-h\` and read the schema before re-issuing.`; }
function invalid(node: CommandDeclaration, problems: ValidationProblem[]): InvocationError { return { category: 'invocation', code: 'invalid-invocation', problems: problems.map((problem) => ({ ...problem, next: problem.next ?? helpNext(node) })) }; }
