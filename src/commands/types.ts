export type Primitive = 'bool' | 'int' | 'path' | 'glob' | 'string';

export interface FlagDeclaration {
  name: string;
  type: Primitive;
  repeat?: true;
  default?: boolean | number | string;
  values?: readonly string[];
  minimum?: number;
  description: string;
}

export interface ArgumentDeclaration {
  name: string;
  repeat: '0+' | '1' | '1+';
  description: string;
}

export interface Constraint {
  check(input: ParsedInput): ValidationProblem[];
}

export interface CommandDeclaration {
  name: string;
  description: string;
  whenToUse?: string;
  model?: string;
  argument?: ArgumentDeclaration;
  flags?: readonly FlagDeclaration[];
  constraints?: readonly Constraint[];
  output?: string;
  effects?: string;
  children?: readonly CommandDeclaration[];
  handler?: HandlerName;
  state?: () => string | null;
}

export type HandlerName = 'outline' | 'find' | 'show' | 'type' | 'inspect' | 'search' | 'check' | 'rename' | 'server-status' | 'server-stop' | 'server-reload';

export interface ParsedInput {
  args: string[];
  flags: Record<string, boolean | number | string | string[]>;
  explicit: ReadonlySet<string>;
}

export interface ValidationProblem {
  field: string;
  received: string;
  expected: string;
  next?: string;
}

export interface Invocation {
  root: string | undefined;
  /** The client's real working directory. Filesystem operands resolve from it; symbol addresses resolve from root. */
  cwd: string;
  json: boolean;
  path: string[];
  declaration: CommandDeclaration;
  input: ParsedInput;
}

export interface InvocationError {
  category: 'invocation';
  code: string;
  problems: ValidationProblem[];
}

export interface ToolError {
  category: 'tool';
  code: string;
  message: string;
  logPath?: string;
  received?: string;
  expected?: string;
  next?: string;
}

export interface Answer {
  element: string;
  attributes?: Record<string, string | number | boolean>;
  body?: string;
  /** A complete XML block already assembled from declarations. */
  raw?: string;
  count: number;
  receipt?: string;
}

export type Completion = Answer | InvocationError | ToolError;
