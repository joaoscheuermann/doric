import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { Sandbox } from 'sandbox';

import {
  readProjectChanges,
  readProjectFileDiff,
} from '../src/lib/workspace/file-changes.js';
import { CONTENT_LIMIT_BYTES } from '../src/lib/workspace/files.js';
import { fakeSandbox } from './helpers/workspace.js';

const run = promisify(execFile);
const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'doric-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox: Sandbox = {
    ...fakeSandbox(),
    root,
    exec: async (input) => {
      const [command = '', ...args] = input.cmd;
      try {
        const result = await run(command, args, {
          cwd: input.cwd ?? root,
          encoding: 'buffer',
        });
        return {
          exitCode: 0,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          stdoutBytes: result.stdout,
          stderrBytes: result.stderr,
        };
      } catch (error) {
        const result = error as {
          code?: number;
          stdout?: Buffer;
          stderr?: Buffer;
        };
        return {
          exitCode: result.code ?? 1,
          stdout: result.stdout?.toString() ?? '',
          stderr: result.stderr?.toString() ?? '',
          stdoutBytes: result.stdout ?? Buffer.alloc(0),
          stderrBytes: result.stderr ?? Buffer.alloc(0),
        };
      }
    },
  };
  const git = async (...args: string[]) => run('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  return {
    root,
    sandbox,
    git,
    write: (path: string, content: string) =>
      writeFile(join(root, path), content),
  };
};

void test('preserves special names and counts HEAD-to-worktree lines without returning patches', async (t) => {
  const f = await fixture(t);
  await f.write('old -> name\n.ts', 'original\n');
  await f.write('edited.ts', 'original\n');
  await f.git('add', '.');
  await f.git('commit', '-qm', 'initial');
  await rename(join(f.root, 'old -> name\n.ts'), join(f.root, 'new "name".ts'));
  await f.write('edited.ts', 'staged\n');
  await f.git('add', '.');
  await f.write('edited.ts', 'unstaged\n');
  await f.write('untracked\nfile.ts', 'new\n');
  const [repo] = await readProjectChanges(f.sandbox);
  assert.equal(repo?.added, 2);
  assert.equal(repo?.removed, 1);
  const renamed = repo?.changes.find((change) => change.status === 'renamed');
  assert.equal(renamed?.path, 'new "name".ts');
  assert.equal(renamed.originalPath, 'old -> name\n.ts');
  const edited = repo?.changes.find((change) => change.path === 'edited.ts');
  assert.equal(edited?.staged, true);
  assert.equal(edited.unstaged, true);
  assert.equal(
    repo?.changes.find((change) => change.path === 'untracked\nfile.ts')
      ?.status,
    'untracked',
  );
  assert.equal('diff' in (repo ?? {}), false);
  const diff = await readProjectFileDiff(f.sandbox, '', renamed.path);
  assert.equal(diff?.original, 'original\n');
  assert.equal(diff?.modified, 'original\n');
});

void test('reads additions, deletions, binary and truncated files individually', async (t) => {
  const f = await fixture(t);
  await f.write('gone.ts', 'old\n');
  await f.write('old-binary.dat', 'old\0bytes');
  await f.write('old-large.txt', 'x'.repeat(CONTENT_LIMIT_BYTES + 10));
  await f.git('add', '.');
  await f.git('commit', '-qm', 'initial');
  await rm(join(f.root, 'gone.ts'));
  await f.write('new.ts', 'new\n');
  await f.write('binary.dat', 'a\0b');
  await f.write('large.txt', 'x'.repeat(CONTENT_LIMIT_BYTES + 10));
  await f.write('old-binary.dat', 'now text');
  await f.write('old-large.txt', 'now short');
  const [repo] = await readProjectChanges(f.sandbox);
  assert.equal(repo?.added, 3);
  assert.equal(repo?.removed, 2);
  const added = await readProjectFileDiff(f.sandbox, '', 'new.ts');
  assert.equal(added?.original, '');
  assert.equal(added?.modified, 'new\n');
  const deleted = await readProjectFileDiff(f.sandbox, '', 'gone.ts');
  assert.equal(deleted?.original, 'old\n');
  assert.equal(deleted?.modified, '');
  const binary = await readProjectFileDiff(f.sandbox, '', 'binary.dat');
  assert.equal(binary?.binary, true);
  assert.equal(binary?.modified, '');
  const large = await readProjectFileDiff(f.sandbox, '', 'large.txt');
  assert.equal(large?.truncated, true);
  assert.equal(large?.modified.length, CONTENT_LIMIT_BYTES);
  const originalBinary = await readProjectFileDiff(
    f.sandbox,
    '',
    'old-binary.dat',
  );
  assert.equal(originalBinary?.binary, true);
  assert.equal(originalBinary?.original, '');
  const originalLarge = await readProjectFileDiff(
    f.sandbox,
    '',
    'old-large.txt',
  );
  assert.equal(originalLarge?.truncated, true);
  assert.equal(originalLarge?.original.length, CONTENT_LIMIT_BYTES);
});

void test('scopes navigation to a working directory and supports an unborn repository', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'src'));
  await f.write('src/new.ts', 'new\n');
  await f.write('outside.ts', 'other\n');
  await f.git('add', 'src/new.ts');
  const [repo] = await readProjectChanges(f.sandbox, 'src');
  assert.equal(repo?.added, 1);
  assert.equal(repo?.removed, 0);
  assert.deepEqual(
    repo?.changes.map((change) => change.path),
    ['src/new.ts'],
  );
  const diff = await readProjectFileDiff(f.sandbox, '', 'src/new.ts');
  assert.equal(diff?.original, '');
  assert.equal(diff?.modified, 'new\n');
  assert.equal(
    await readProjectFileDiff(f.sandbox, '../outside', 'outside.ts'),
    undefined,
  );
});

void test('does not double-count staged edits that the working tree reverses', async (t) => {
  const f = await fixture(t);
  await f.write('file\tname.txt', 'one\ntwo\n');
  await f.git('add', '.');
  await f.git('commit', '-qm', 'initial');
  await f.write('file\tname.txt', 'three\n');
  await f.git('add', '.');
  await f.write('file\tname.txt', 'one\ntwo\n');
  const [repo] = await readProjectChanges(f.sandbox);
  assert.equal(repo?.changes.length, 1);
  assert.equal(repo?.added, 0);
  assert.equal(repo?.removed, 0);
});

void test('identifies an unresolved merge as conflicted', async (t) => {
  const f = await fixture(t);
  await f.write('conflict.ts', 'base\n');
  await f.git('add', '.');
  await f.git('commit', '-qm', 'initial');
  await f.git('checkout', '-qb', 'other');
  await f.write('conflict.ts', 'other\n');
  await f.git('commit', '-qam', 'other');
  await f.git('checkout', '-q', '-');
  await f.write('conflict.ts', 'current\n');
  await f.git('commit', '-qam', 'current');
  await assert.rejects(f.git('merge', 'other'));
  const [repo] = await readProjectChanges(f.sandbox);
  assert.equal(repo?.changes[0]?.status, 'conflicted');
  const diff = await readProjectFileDiff(f.sandbox, '', 'conflict.ts');
  assert.equal(diff?.original, 'current\n');
  assert.match(diff?.modified ?? '', /<<<<<<< HEAD/);
});
