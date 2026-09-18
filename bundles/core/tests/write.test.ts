import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import hostPath from 'node:path';
import { posix as path } from 'node:path';
import { describe, test } from 'node:test';

import type { SandboxSession } from 'sandbox';

import factory from '../tools/write.js';

describe('write tool', () => {
  test('creates parent directories and returns byte count with diff', async () => {
    const sandbox = await fakeSandbox('write');

    const result = await factory(sandbox).execute({
      path: 'notes/today.txt',
      content: 'hello',
    });

    assert.equal(result.success, true);

    assert.equal(result.bytes_written, 5);

    assert.match(result.diff ?? '', /1 \+hello/);

    assert.equal(
      await sandbox.readHost('/workspace/repo/notes/today.txt'),
      'hello',
    );

    assert.deepEqual(sandbox.reads, ['/workspace/repo/notes/today.txt']);

    assert.deepEqual(sandbox.writes, ['/workspace/repo/notes/today.txt']);

    await sandbox.dispose();
  });

  test('rejects empty paths with structured error output', async () => {
    const sandbox = await fakeSandbox('write-empty');

    const result = await factory(sandbox).execute({
      path: '',
      content: 'hello',
    });

    assert.deepEqual(result, {
      success: false,
      bytes_written: 0,
      error: 'Path must not be empty',
    });

    assert.deepEqual(sandbox.reads, []);

    assert.deepEqual(sandbox.writes, []);

    await sandbox.dispose();
  });
});

type FakeSandbox = SandboxSession & {
  readonly reads: string[];
  readonly writes: string[];
  readHost(path: string): Promise<string>;
};

const fakeSandbox = async (name: string): Promise<FakeSandbox> => {
  const root = await mkdtemp(hostPath.join(os.tmpdir(), `doric-${name}-`));
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

      const host = target(sandboxPath);

      await mkdir(hostPath.dirname(host), { recursive: true });

      await writeFile(host, content, 'utf8');
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

    readHost(sandboxPath) {
      return readFile(target(sandboxPath), 'utf8');
    },
  };
};
