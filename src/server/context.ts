import { DeclarationResolver } from '../core/declarations.js';
import { SourceReader } from '../core/source.js';
import { ProjectRegistry } from './projects.js';
import { TsServerSession } from './tsserver.js';

/** The per-resident semantic API used by leaf handlers inside the FIFO invocation queue. */
export interface SemanticContext {
  root: string;
  session: TsServerSession;
  projects: ProjectRegistry;
  resolver: DeclarationResolver;
  source: SourceReader;
}

export function createSemanticContext(root: string, writeLog: (chunk: Buffer) => void): SemanticContext {
  const session = new TsServerSession(root, undefined, writeLog);
  session.start();
  const projects = new ProjectRegistry(root, session);
  const source = new SourceReader(session.location.path);
  return { root, session, projects, resolver: new DeclarationResolver(root, session, projects, source), source };
}
