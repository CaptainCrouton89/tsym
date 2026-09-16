import path from 'node:path';
import { existsSync } from 'node:fs';
import { Project } from 'ts-morph';
import { NoProject, type Workspace } from './workspace.js';

const projects = new WeakMap<Workspace, Map<string, Project>>();

/** Temporary legacy adapter for old leaves until the unit-4 cutover deletes ts-morph. */
export function projectFor(workspace: Workspace, rel: string): Project {
  const tsconfig = nearestTsconfig(path.dirname(workspace.abs(rel))) ?? workspace.tsconfig;
  const key = tsconfig ?? workspace.root;
  const cached = projects.get(workspace)?.get(key);
  if (cached) return cached;
  let project: Project;
  if (tsconfig) project = new Project({ tsConfigFilePath: tsconfig, skipFileDependencyResolution: true });
  else if (workspace.marker !== 'none') {
    project = new Project({ skipFileDependencyResolution: true, compilerOptions: { allowJs: true } });
    project.addSourceFilesAtPaths(workspace.files().map((file) => workspace.abs(file)));
  } else throw new NoProject(`no tsconfig.json above ${rel} and ${workspace.root} is not a project`);
  const map = projects.get(workspace) ?? new Map<string, Project>();
  map.set(key, project);
  projects.set(workspace, map);
  return project;
}

function nearestTsconfig(dir: string): string | null {
  let current = dir;
  for (;;) {
    const candidate = path.join(current, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
