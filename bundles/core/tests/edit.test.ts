import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import hostPath from 'node:path';
import { posix as path } from 'node:path';
import { describe, test } from 'node:test';

import type { SandboxSession } from 'sandbox';

import factory from '../tools/edit.js';

describe('edit tool', () => {
  test('updates a unique exact match and returns first changed line', async () => {
    const sandbox = await fakeSandbox('edit-exact');

    await sandbox.seed(
      '/workspace/repo/src/lib.ts',
      'one\noldCall();\nthree\n',
    );

    const result = await factory(sandbox).execute({
      path: 'src/lib.ts',
      edits: [{ oldText: 'oldCall();', newText: 'newCall();' }],
    });

    assert.equal(result.success, true);

    assert.equal(result.first_changed_line, 2);

    assert.match(result.diff, /2 -oldCall\(\);/);

    assert.match(result.diff, /2 \+newCall\(\);/);

    assert.equal(
      await sandbox.readHost('/workspace/repo/src/lib.ts'),
      'one\nnewCall();\nthree\n',
    );

    assert.deepEqual(sandbox.reads, ['/workspace/repo/src/lib.ts']);

    assert.deepEqual(sandbox.writes, ['/workspace/repo/src/lib.ts']);

    await sandbox.dispose();
  });

  test('rejects duplicate old text with context guidance', async () => {
    const sandbox = await fakeSandbox('edit-duplicate');

    await sandbox.seed('/workspace/repo/same.txt', 'same\nsame\n');

    const result = await factory(sandbox).execute({
      path: 'same.txt',
      edits: [{ oldText: 'same', newText: 'changed' }],
    });

    assert.equal(result.success, false);

    assert.match(result.error ?? '', /Please provide more context/);

    await sandbox.dispose();
  });

  test('distinguishes missing files from other read failures', async () => {
    const sandbox = await fakeSandbox('edit-read-errors');

    await sandbox.mkdir('/workspace/repo/src');

    const tool = factory(sandbox);

    const missing = await tool.execute({
      path: 'missing.txt',
      edits: [{ oldText: 'old', newText: 'new' }],
    });

    const directory = await tool.execute({
      path: 'src',
      edits: [{ oldText: 'old', newText: 'new' }],
    });

    assert.match(missing.error ?? '', /^File not found: missing\.txt$/);

    assert.match(directory.error ?? '', /^Failed to read file:/);

    await sandbox.dispose();
  });
});

type FakeSandbox = SandboxSession & {
  readonly reads: string[];
  readonly writes: string[];
  seed(path: string, content: string): Promise<void>;

  mkdir(path: string): Promise<void>;

  readHost(path: string): Promise<string>;
};

const fakeSandbox = async (name: string): Promise<FakeSandbox> => {
  const root = await workspace(name);
  const reads: string[] = [];
  const writes: string[] = [];

  const target = (sandboxPath: string): string => {
    const resolved = path.normalize(
      path.isAbsolute(sandboxPath)
        ? sandboxPath
        : path.join('/workspace', sandboxPath),
    );
    const relative =
      resolved === '/workspace' ? '' : resolved.slice('/workspace/'.length);

    return hostPath.join(root, ...relative.split('/'));
  };

  const writeHost = async (
    sandboxPath: string,
    content: string,
  ): Promise<void> => {
    const host = target(sandboxPath);

    await mkdir(hostPath.dirname(host), { recursive: true });

    await writeFile(host, content, 'utf8');
  };

  return {
    id: 'fake-sandbox',
    root: '/workspace/repo',
    reads,
    writes,

    async exec() {
      throw new Error('fake sandbox does not execute commands');
    },

    async cloneRepo() {
      throw new Error('fake sandbox does not clone repositories');
    },

    async readFile(sandboxPath) {
      reads.push(sandboxPath);

      return readFile(target(sandboxPath), 'utf8');
    },

    async writeFile(sandboxPath, content) {
      writes.push(sandboxPath);

      await writeHost(sandboxPath, content);
    },

    async putFile() {
      throw new Error('fake sandbox does not put binary files');
    },

    async getFile() {
      throw new Error('fake sandbox does not get binary files');
    },

    async diff() {
      return '';
    },

    async ssh() {
      return undefined;
    },

    async dispose() {
      await rm(root, { recursive: true, force: true });
    },

    seed: writeHost,

    async mkdir(sandboxPath) {
      await mkdir(target(sandboxPath), { recursive: true });
    },

    readHost(sandboxPath) {
      return readFile(target(sandboxPath), 'utf8');
    },
  };
};

const workspace = (name: string): Promise<string> =>
  mkdtemp(hostPath.join(os.tmpdir(), `doric-${name}-`));
