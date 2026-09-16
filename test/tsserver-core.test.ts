import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DeclarationResolver } from '../src/core/declarations.js';
import { SourceReader } from '../src/core/source.js';
import { ProjectRegistry } from '../src/server/projects.js';
import { TsServerSession } from '../src/server/tsserver.js';

test('tsserver bootstrap closes its document and canonicalizes declaration and usage addresses', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'symbols-project-'));
  const root = path.join(temp, 'fixture');
  cpSync('test/fixture', root, { recursive: true });
  const session = new TsServerSession(root);
  try {
    const projects = new ProjectRegistry(root, session);
    await projects.bootstrap();
    assert.equal(projects.records().length, 1);
    const resolver = new DeclarationResolver(root, session, projects, new SourceReader(session.location.path));
    const declaration = await resolver.resolve('greet');
    const usage = await resolver.resolve('src/main.ts:3:1');
    const module = await resolver.resolve('src/greet.ts:0:0');
    assert.equal(declaration.address, 'src/greet.ts:2:17');
    assert.equal(usage.address, 'src/app.ts:5:17');
    assert.equal(module.address, 'src/greet.ts:0:0');
  } finally {
    session.stop();
    rmSync(temp, { recursive: true, force: true });
  }
});
