import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DeclarationError, DeclarationResolver } from '../src/core/declarations.js';
import { SourceReader } from '../src/core/source.js';
import { buildIndex } from '../src/index/build.js';
import { scopeFiles } from '../src/read/read.js';
import { Store } from '../src/store/store.js';
import { Ts7Host } from '../src/ts7/api.js';
import { ConfiguredProjects } from '../src/ts7/projects.js';
import { ProjectRegistry } from '../src/server/projects.js';
import { TsServerSession } from '../src/server/tsserver.js';

function fixture(name: string) {
  const temp = mkdtempSync(path.join(tmpdir(), `tsym-ts7-${name}-`));
  const root = path.join(temp, 'fixture');
  cpSync('test/fixture', root, { recursive: true });
  return { temp, root };
}

function close(session: TsServerSession, host: Ts7Host, temp: string) {
  host.close();
  session.stop();
  rmSync(temp, { recursive: true, force: true });
}

function indexed(root: string, program: Ts7Host) {
  const projects = new ConfiguredProjects(root, program);
  const store = new Store(path.join(root, '.tsym-test-store'));
  projects.load();
  buildIndex(root, program, projects, store);
  const source = new SourceReader({
    refreshFile(file: string) { projects.refreshFile(file); },
    sourceFile: (file: string) => projects.sourceFile(file),
    anySourceFile: (file: string) => projects.anySourceFile(file),
  });
  return { projects, store, source, resolver: new DeclarationResolver(root, source, () => store) };
}

test('TypeScript 7 loads each discovered config in one snapshot and assigns overlapping files to the first config', async () => {
  const { temp, root } = fixture('projects');
  writeFileSync(path.join(root, 'src', 'shared.ts'), 'export const shared = 1;\n');
  const nested = path.join(root, 'nested');
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src/**/*.ts'] }));
  mkdirSync(nested);
  writeFileSync(path.join(root, 'nested', 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['../src/shared.ts'] }));
  const session = new TsServerSession(root);
  const host = new Ts7Host(root);
  try {
    const projects = new ProjectRegistry(root, session, host);
    const records = await projects.bootstrap();
    assert.equal(records.length, 2);
    assert.match(records[0]!.config, /nested\/tsconfig\.json$/);
    assert.match((await projects.membership(path.join(root, 'src', 'shared.ts')))!.config, /nested\/tsconfig\.json$/);
  } finally { close(session, host, temp); }
});

test('unconfigured source remains outside the TypeScript 7 project union and preserves the not-in-program error', async () => {
  const { temp, root } = fixture('outside');
  const outside = path.join(root, 'outside.ts');
  const generated = path.join(root, 'dist', 'generated.ts');
  writeFileSync(outside, 'export const outside = 1;\n');
  mkdirSync(path.dirname(generated));
  writeFileSync(generated, 'export const generated = 1;\n');
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src', 'dist'] }));
  const session = new TsServerSession(root);
  const host = new Ts7Host(root);
  try {
    const projects = new ProjectRegistry(root, session, host);
    await projects.bootstrap();
    assert.ok(await projects.membership(path.join(root, 'src', 'greet.ts')));
    assert.equal(await projects.membership(outside), null);
    assert.equal(await projects.membership(generated), null);
    const index = indexed(root, host);
    await assert.rejects(index.resolver.resolve('outside.ts:1:14'), (error: unknown) => error instanceof DeclarationError && error.code === 'not-in-program');
    await assert.rejects(index.resolver.resolve('dist/generated.ts:1:14'), (error: unknown) => error instanceof DeclarationError && error.code === 'not-in-program');
    index.store.close();
  } finally { close(session, host, temp); }
});

test('configured JavaScript files pass the scope filter before project membership', async () => {
  const { temp, root } = fixture('javascript');
  const file = path.join(root, 'src', 'plain.js');
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', allowJs: true }, include: ['src/**/*'] }));
  writeFileSync(file, 'export const plain = 1;\n');
  const session = new TsServerSession(root);
  const host = new Ts7Host(root);
  try {
    const projects = new ProjectRegistry(root, session, host);
    await projects.bootstrap();
    const index = indexed(root, host);
    const scope = await scopeFiles({ root, session, program: host, projects, resolver: index.resolver, source: index.source }, root, ['src/plain.js']);
    assert.deepEqual(scope, { files: [file], notInProgram: 0 });
    index.store.close();
  } finally { close(session, host, temp); }
});

test('TypeScript 7 source parsing stays aligned with tsserver coordinates after an edit', async () => {
  const { temp, root } = fixture('edit');
  const file = path.join(root, 'src', 'greet.ts');
  const session = new TsServerSession(root);
  const host = new Ts7Host(root);
  try {
    const projects = new ProjectRegistry(root, session, host);
    await projects.bootstrap();
    const index = indexed(root, host);
    assert.equal((await index.resolver.resolve('greet')).address, 'src/greet.ts:2:17');
    writeFileSync(file, `\n${readFileSync(file, 'utf8')}`);
    index.projects.refreshFile(file);
    buildIndex(root, host, index.projects, index.store);
    assert.match((await index.resolver.resolve('greet')).address, /^src\/greet\.ts:3:\d+$/);
    index.store.close();
  } finally { close(session, host, temp); }
});

test('TypeScript 7 refreshes changed disk text and removes deleted files from the next snapshot', () => {
  const { temp, root } = fixture('disk-refresh');
  const config = path.join(root, 'tsconfig.json');
  const changed = path.join(root, 'src', 'greet.ts');
  const removed = path.join(root, 'src', 'remove-me.ts');
  const host = new Ts7Host(root);
  try {
    writeFileSync(removed, 'export const removeMe = true;\n');
    host.load([config]);
    const replacement = 'export const greeting = "fresh";\n';
    writeFileSync(changed, replacement);
    host.update({ fileChanges: { changed: [changed] } });
    assert.equal(host.sourceFile(config, changed)?.text, replacement);
    rmSync(removed);
    host.update({ fileChanges: { deleted: [removed] } });
    assert.equal(host.sourceFile(config, removed), undefined);
  } finally {
    host.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('TypeScript 7 disposes replaced snapshots and recovers once after its child is killed', () => {
  const { temp, root } = fixture('recovery');
  const config = path.join(root, 'tsconfig.json');
  const changed = path.join(root, 'src', 'greet.ts');
  const host = new Ts7Host(root);
  try {
    host.load([config]);
    for (let index = 0; index < 100; index++) assert.ok(host.update({ fileChanges: { changed: [changed] } }).length > 0);
    const pid = Number(execFileSync('pgrep', ['-P', `${process.pid}`], { encoding: 'utf8' }).trim().split('\n').at(-1));
    assert.ok(Number.isInteger(pid) && pid > 0);
    process.kill(pid, 'SIGKILL');
    const started = performance.now();
    assert.ok(host.update({ fileChanges: { changed: [changed] } }).length > 0);
    assert.ok(performance.now() - started < 500, 'recovery exceeded the 500 ms budget');
  } finally {
    host.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
