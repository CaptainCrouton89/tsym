import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DeclarationError, DeclarationResolver } from '../src/core/declarations.js';
import { declarationError } from '../src/commands/handlers.js';
import { completionCode } from '../src/output.js';
import { SourceReader } from '../src/core/source.js';
import { ProjectRegistry } from '../src/server/projects.js';
import { TsServerSession } from '../src/server/tsserver.js';

test('tsserver bootstrap retains its document and canonicalizes declaration and usage addresses', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'tsym-project-'));
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

test('geterrForProject resolves on its requestCompleted event with every diagnostic event collected, then frees the request slot', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'tsym-geterr-'));
  const root = path.join(temp, 'fixture');
  cpSync('test/fixture', root, { recursive: true });
  writeFileSync(path.join(root, 'src', 'broken.ts'), 'export const n: number = "text";\n');
  const session = new TsServerSession(root);
  try {
    const projects = new ProjectRegistry(root, session);
    await projects.bootstrap();
    const seed = path.join(root, 'src', 'broken.ts');
    const events = await session.withOpen(seed, () => session.diagnosticsForProject(seed));
    const semantic = events.filter((event) => event.kind === 'semanticDiag' && event.file === seed);
    assert.equal(semantic.length, 1);
    assert.equal((semantic[0].diagnostics[0] as { code: number }).code, 2322);
    assert.ok(events.some((event) => event.kind === 'syntaxDiag'));
    // The slot is free again: an ordinary request is accepted rather than rejected as "attempted while pending".
    assert.ok(await session.navtree(seed));
  } finally {
    session.stop();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a failed scoped close frees the session request slot', async () => {
  const session = new TsServerSession('/root');
  const transport = session as unknown as {
    child: { stdin: { write(body: string, callback?: (error: Error | null) => void): boolean } };
    read(chunk: Buffer): void;
  };
  transport.child = {
    stdin: {
      write(body, callback) {
        const request = JSON.parse(body) as { seq: number; command: string };
        if (request.command === 'close') throw new Error('close write failed');
        queueMicrotask(() => {
          const response = JSON.stringify({ type: 'response', request_seq: request.seq, success: true });
          transport.read(Buffer.from(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`));
          callback?.(null);
        });
        return true;
      },
    },
  };

  await assert.rejects(session.withOpen('/root/file.ts', async () => undefined), /close write failed/);
  await session.navto('still-usable');
});

test('a command callback failure frees ordinary and diagnostic request slots', async () => {
  const session = new TsServerSession('/root');
  const transport = session as unknown as {
    child: { stdin: { write(body: string, callback?: (error: Error | null) => void): boolean } };
    read(chunk: Buffer): void;
  };
  transport.child = {
    stdin: {
      write(body, callback) {
        const request = JSON.parse(body) as { seq: number };
        queueMicrotask(() => {
          const response = JSON.stringify({ type: 'response', request_seq: request.seq, success: true });
          transport.read(Buffer.from(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`));
          callback?.(null);
        });
        return true;
      },
    },
  };

  session.setCommandHandler(() => { throw new Error('command callback failed'); });
  await assert.rejects(session.navto('first'), /command callback failed/);
  session.setCommandHandler(() => {});
  await session.navto('second');

  session.setCommandHandler(() => { throw new Error('command callback failed'); });
  await assert.rejects(session.diagnosticsForProject('/root/file.ts'), /command callback failed/);
  session.setCommandHandler(() => {});
  await session.navto('third');
});

test('a resolver rejection inside a handler becomes an exit-2 invocation error, not a tool error', async () => {
  const invocation = { root: '/r', cwd: '/r', json: false, path: ['show'], declaration: { name: 'show', description: '', argument: { name: 'symbol', repeat: '1+' as const, description: '' } }, input: { args: ['nope'], flags: {}, explicit: new Set<string>() } };
  const ambiguous = declarationError(new DeclarationError('ambiguous-symbol', 'x is ambiguous.', ['a.ts:1:1', 'b.ts:2:2']), invocation);
  assert.equal(ambiguous.category, 'invocation');
  assert.equal(ambiguous.code, 'ambiguous-symbol');
  assert.equal(ambiguous.problems[0].field, 'symbol');
  assert.equal(ambiguous.problems[0].next, 'Pass one of: a.ts:1:1 b.ts:2:2');
  assert.equal(completionCode(ambiguous), 2);
  const missing = declarationError(new DeclarationError('no-such-path', 'nope does not exist.'), invocation);
  assert.equal(missing.problems[0].expected, 'an existing file or directory under --root');
  assert.match(missing.problems[0].next!, /tsym show -h/);
});

test('a bare name with several navto candidates is resolved one request at a time and reports the candidates', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'tsym-ambiguous-'));
  const root = path.join(temp, 'fixture');
  cpSync('test/fixture', root, { recursive: true });
  writeFileSync(path.join(root, 'src', 'dup-a.ts'), 'export const dup = 1;\n');
  writeFileSync(path.join(root, 'src', 'dup-b.ts'), 'export const dup = 2;\n');
  const session = new TsServerSession(root);
  try {
    const projects = new ProjectRegistry(root, session);
    await projects.bootstrap();
    const resolver = new DeclarationResolver(root, session, projects, new SourceReader(session.location.path));
    await assert.rejects(resolver.resolve('dup'), (error: unknown) => {
      assert.ok(error instanceof DeclarationError, `expected DeclarationError, got ${String(error)}`);
      assert.equal(error.code, 'ambiguous-symbol');
      assert.deepEqual(error.candidates.sort(), ['src/dup-a.ts:1:14', 'src/dup-b.ts:1:14']);
      return true;
    });
  } finally {
    session.stop();
    rmSync(temp, { recursive: true, force: true });
  }
});
