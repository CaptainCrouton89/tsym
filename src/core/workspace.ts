import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Lang } from '@ast-grep/napi';
import { Project } from 'ts-morph';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

export class Workspace {
  readonly root: string;
  readonly tsconfig: string | null;
  private fileList: string[] | null = null;
  private tsProject: Project | null = null;

  constructor(root: string, tsconfig: string | null) {
    this.root = root;
    this.tsconfig = tsconfig;
  }

  /** Path relative to the root, `/`-separated. */
  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  /** Absolute path for an input path: absolute as-is; relative first against the process cwd, then against the root. */
  abs(p: string): string {
    if (path.isAbsolute(p)) return p;
    const fromCwd = path.resolve(p);
    return existsSync(fromCwd) ? fromCwd : path.join(this.root, p);
  }

  read(rel: string): string {
    return readFileSync(this.abs(rel), 'utf8');
  }

  /**
   * Source files (TS/JS family) in the workspace, relative to the root.
   * Uses `git ls-files` (tracked + untracked, honoring .gitignore) when the root is in a git repo,
   * else a directory walk that skips node_modules/dist/build/.git.
   */
  files(glob?: string): string[] {
    if (!this.fileList) this.fileList = listFiles(this.root);
    if (!glob) return this.fileList;
    return this.fileList.filter((f) => matchesGlob(f, glob));
  }

  /** ts-morph program over the workspace. Built on first use; kept for the life of this object. */
  project(): Project {
    if (this.tsProject) return this.tsProject;
    if (this.tsconfig) {
      this.tsProject = new Project({ tsConfigFilePath: this.tsconfig, skipFileDependencyResolution: true });
    } else {
      this.tsProject = new Project({ skipFileDependencyResolution: true, compilerOptions: { allowJs: true } });
      this.tsProject.addSourceFilesAtPaths(this.files().map((f) => this.abs(f)));
    }
    return this.tsProject;
  }
}

/**
 * Resolve the workspace containing `dir`: the nearest ancestor holding a tsconfig.json,
 * else package.json, else a .git directory, else `dir` itself.
 */
export function openWorkspace(dir: string = process.cwd()): Workspace {
  const start = path.resolve(dir);
  for (const marker of ['tsconfig.json', 'package.json', '.git']) {
    let cur = start;
    for (;;) {
      const candidate = path.join(cur, marker);
      if (existsSync(candidate)) {
        return new Workspace(cur, marker === 'tsconfig.json' ? candidate : findTsconfig(cur));
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return new Workspace(start, null);
}

function findTsconfig(root: string): string | null {
  const p = path.join(root, 'tsconfig.json');
  return existsSync(p) ? p : null;
}

export function langFor(file: string): Lang | null {
  switch (path.extname(file)) {
    case '.ts':
    case '.mts':
    case '.cts':
      return Lang.TypeScript;
    case '.tsx':
      return Lang.Tsx;
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return Lang.JavaScript;
    default:
      return null;
  }
}

export function matchesGlob(file: string, glob: string): boolean {
  // A bare directory or name matches as a prefix / anywhere; a real glob goes to path.matchesGlob.
  if (!/[*?[{]/.test(glob)) return file === glob || file.startsWith(glob.replace(/\/$/, '') + '/');
  const pattern = glob.includes('/') ? glob : `**/${glob}`;
  return path.matchesGlob(file, pattern);
}

function listFiles(root: string): string[] {
  let out: string[];
  try {
    const raw = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 28,
    });
    out = raw.split('\0').filter(Boolean);
  } catch {
    out = [];
    walk(root, '', out);
  }
  return out.filter((f) => SOURCE_EXT.has(path.extname(f)) && !f.split('/').some((seg) => SKIP_DIRS.has(seg)) && existsSync(path.join(root, f)));
}

function walk(root: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, relPath, out);
    } else if (entry.isFile() || (entry.isSymbolicLink() && safeIsFile(path.join(root, relPath)))) {
      out.push(relPath);
    }
  }
}

function safeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
