import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseInvocation } from '../src/commands/tree.js';
import show from '../src/commands/handlers/show.js';
import typeHandler from '../src/commands/handlers/type.js';
import outline from '../src/commands/handlers/outline.js';
import { buildIndex } from '../src/index/build.js';
import { createSemanticContext } from '../src/server/context.js';
import { Store } from '../src/store/store.js';
import { Ts7Host } from '../src/ts7/api.js';
import { ConfiguredProjects } from '../src/ts7/projects.js';
import type { Answer, Completion, Invocation } from '../src/commands/types.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tsym-displayed-files-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', strict: true }, include: ['src/**/*.ts'] }));
  writeFileSync(path.join(root, 'src', 'first.ts'), 'export const first = 1;\nexport type Value = { value: number };\n');
  writeFileSync(path.join(root, 'src', 'second.ts'), 'export const second = 2;\n');
  writeFileSync(path.join(root, 'src', 'typed.ts'), "import type { Value } from './first.js';\nexport const typed: Value = { value: 1 };\n");
  writeFileSync(path.join(root, 'src', 'imports.ts'), "import { first } from './first.js';\nvoid first;\n");
  const builder = new Ts7Host(root);
  const configured = new ConfiguredProjects(root, builder);
  const store = new Store(path.join(root, 'store'));
  configured.load();
  buildIndex(root, builder, configured, store);
  const context = createSemanticContext(root);
  context.store = store;
  return { root, context, close: () => { context.program.close(); builder.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function invocation(root: string, args: string[]): Invocation {
  const parsed = parseInvocation(args, root);
  assert.ok(!('category' in parsed) && !('help' in parsed));
  return parsed;
}

function answer(completion: Completion): Answer {
  assert.ok(!('category' in completion));
  return completion;
}

test('handlers report only source files whose declarations they display', async () => {
  const { root, context, close } = fixture();
  try {
    const shown = answer(await show(context, invocation(root, ['show', 'first', 'second', '--limit', '1'])));
    assert.deepEqual(shown.displayedFiles, [path.join(root, 'src', 'first.ts')]);

    const typed = answer(await typeHandler(context, invocation(root, ['type', 'typed', '--def'])));
    assert.deepEqual(typed.displayedFiles, [path.join(root, 'src', 'typed.ts')]);

    const containers = answer(await outline(context, invocation(root, ['outline', 'src', '--depth', '1'])));
    assert.deepEqual(containers.displayedFiles, []);

    const capped = answer(await outline(context, invocation(root, ['outline', 'src', '--depth', '2', '--limit', '1'])));
    assert.deepEqual(capped.displayedFiles, [path.join(root, 'src', 'first.ts')]);

    const importOnly = answer(await outline(context, invocation(root, ['outline', 'src/imports.ts', '--imports'])));
    assert.deepEqual(importOnly.displayedFiles, [path.join(root, 'src', 'imports.ts')]);
  } finally {
    close();
  }
});
