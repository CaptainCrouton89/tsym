import { DeclarationResolver } from '../core/declarations.js';
import { SourceReader } from '../core/source.js';
import { Ts7Host } from '../ts7/api.js';
import { ProjectRegistry } from './projects.js';
import { TsServerSession } from './tsserver.js';

/** The per-resident semantic API used by leaf handlers inside the FIFO invocation queue. */
export interface SemanticContext {
  root: string;
  session: TsServerSession;
  program: Ts7Host;
  projects: ProjectRegistry;
  resolver: DeclarationResolver;
  source: SourceReader;
}

export function createSemanticContext(root: string, writeLog: (chunk: Buffer) => void): SemanticContext {
  const session = new TsServerSession(root, undefined, writeLog);
  session.start();
  const program = new Ts7Host(root);
  const projects = new ProjectRegistry(root, session, program);
  const source = new SourceReader(projects);
  return { root, session, program, projects, resolver: new DeclarationResolver(root, session, projects, source), source };
}
