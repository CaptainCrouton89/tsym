import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const scratch = path.join(process.env.HOME!, '.crouter', 'canvas', 'scratch');

function fixture(): { root: string; cache: string; outside: string; close: () => void } {
  const root = mkdtempSync(path.join(scratch, 'tsym-preflight-'));
  const cache = mkdtempSync(path.join(scratch, 'tsym-preflight-cache-'));
  const outside = `${root}-outside.ts`;
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'tsconfig.json'), '{ "compilerOptions": { "target": "ES2022", "module": "Node16", "moduleResolution": "Node16", "strict": true }, "include": ["src", "../' + path.basename(outside) + '"] }');
  writeFileSync(path.join(root, 'src', 'rename-preflight.ts'), `import { readFile } from 'node:fs';

export const renameShadowTarget = 1;
export function renameShadowUse() {
  const renamedShadow = 2;
  return renameShadowTarget + renamedShadow;
}

export const renameImportTarget = 1;
export function renameImportUse() {
  return renameImportTarget + Number(Boolean(readFile));
}

export class RenameMemberCollision {
  renameMemberTarget() { return 1; }
  renamedMember() { return 2; }
  use() { return this.renameMemberTarget(); }
}

export const renameComputedTarget = 'key';
export const renameComputedUse = { [renameComputedTarget]: 1 };

declare global {
  interface RenameOutsideMerged { local: string; }
}
`);
  writeFileSync(outside, `declare global {
  interface RenameOutsideMerged { external: number; }
}
export {};
`);
  return { root, cache, outside, close: () => { run(root, cache, 'server', 'stop'); rmSync(root, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); rmSync(outside, { force: true }); } };
}

function run(root: string, cache: string, ...args: string[]) {
  return spawnSync(process.execPath, ['dist/cli.js', '--root', root, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
}

test('rename refuses computed names, external declarations, and name conflicts before writing', () => {
  const setup = fixture();
  try {
    const source = path.join(setup.root, 'src', 'rename-preflight.ts');
    const before = readFileSync(source);
    for (const rename of [
      { symbol: 'src/rename-preflight.ts:20:14', name: 'renamedComputed', code: 'rename-through-computed-name', site: 'src/rename-preflight.ts:21:37' },
      { symbol: 'src/rename-preflight.ts:24:13', name: 'renamedOutside', code: 'rename-outside-workspace', site: 'src/rename-preflight.ts:24:13' },
      { symbol: 'src/rename-preflight.ts:3:14', name: 'renamedShadow', code: 'rename-conflict', site: 'src/rename-preflight.ts:6:10' },
      { symbol: 'src/rename-preflight.ts:9:14', name: 'readFile', code: 'rename-conflict', site: 'src/rename-preflight.ts:9:14' },
      { symbol: 'src/rename-preflight.ts:15:3', name: 'renamedMember', code: 'rename-conflict', site: 'src/rename-preflight.ts:15:3' },
    ]) {
      for (const apply of [false, true]) {
        const result = run(setup.root, setup.cache, 'rename', rename.symbol, rename.name, ...(apply ? ['--apply'] : []));
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stdout, new RegExp(rename.code));
        assert.match(result.stdout, new RegExp(rename.site.replace(/[.]/g, '\\.')));
        assert.deepEqual(readFileSync(source), before);
      }
    }
  } finally {
    setup.close();
  }
});
