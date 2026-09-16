import { DeclarationResolver } from '../core/declarations.js';
import { SourceReader } from '../core/source.js';
import { Ts7Host } from '../ts7/api.js';
import { ProjectRegistry } from './projects.js';

/** What a store-reading leaf reports about the index it answered from (design §4.5). */
export interface IndexState {
  indexedAt: string;
  state: 'current' | 'indexing' | 'stale';
  built: import('../index/build.js').BuiltIndex;
}

/** The per-resident semantic API used by leaf handlers inside the FIFO invocation queue. */
export interface SemanticContext {
  root: string;
  program: Ts7Host;
  projects: ProjectRegistry;
  resolver: DeclarationResolver;
  source: SourceReader;
  store?: import('../store/store.js').Store;
  index?: IndexState;
}

export function createSemanticContext(root: string): SemanticContext {
  const program = new Ts7Host(root);
  const projects = new ProjectRegistry(root, program);
  const source = new SourceReader(projects);
  let context!: SemanticContext;
  context = { root, program, projects, resolver: new DeclarationResolver(root, source, () => context.store), source };
  return context;
}
