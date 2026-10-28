import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import type { Host } from 'runtime/contracts';
import type { Sandbox } from 'sandbox';

import { tool as factory } from '../src/host/tools/cwd.js';
import { fakeHost, WORKSPACE_ROOT } from './fake-sandbox.js';
import { bindTool } from './support/services.js';

void describe('cwd tool', () => {
  void test('reports the current directory without a path', async () => {
    const host = fakeHost({ cwd: '/workspace/repo' });

    assert.deepEqual(await tool(host).execute({}), {
      cwd: '/workspace/repo',
      status: 'reported',
      repositoryRoot: false,
    });

    assert.deepEqual(await tool(host).execute({ path: '' }), {
      cwd: '/workspace/repo',
      status: 'reported',
      repositoryRoot: false,
    });

    // A blank path names no directory either, exactly as the HTTP route reads
    // one, so it can never move into a directory named with spaces.
    assert.deepEqual(await tool(host).execute({ path: '   ' }), {
      cwd: '/workspace/repo',
      status: 'reported',
      repositoryRoot: false,
    });
    assert.equal(host.workspace.cwd(), '/workspace/repo');
  });

  void test('moves to a relative path resolved against the current directory', async () => {
    const host = fakeHost();

    assert.deepEqual(await tool(host).execute({ path: 'repo' }), {
      cwd: '/workspace/repo',
      status: 'set',
      repositoryRoot: false,
    });

    assert.deepEqual(await tool(host).execute({ path: 'src' }), {
      cwd: '/workspace/repo/src',
      status: 'set',
      repositoryRoot: false,
    });

    assert.deepEqual(await tool(host).execute({ path: '..' }), {
      cwd: '/workspace/repo',
      status: 'set',
      repositoryRoot: false,
    });

    assert.equal(host.workspace.cwd(), '/workspace/repo');
  });

  void test('moves to an absolute path and reports the resolved directory', async () => {
    const host = fakeHost();

    assert.deepEqual(
      await tool(host).execute({ path: '/workspace/repo/src' }),
      {
        cwd: '/workspace/repo/src',
        status: 'set',
        repositoryRoot: false,
      },
    );

    assert.deepEqual(
      await tool(host).execute({ path: '/workspace/repo/./src/../src/' }),
      { cwd: '/workspace/repo/src', status: 'set', repositoryRoot: false },
    );

    assert.equal(host.workspace.cwd(), '/workspace/repo/src');
  });

  void test('refuses a path that is missing or is not a directory', async () => {
    const root = await workspace('cwd-refused');
    const host = fakeHost({ localRoot: root });

    try {
      assert.deepEqual(await tool(host).execute({ path: 'repo' }), {
        cwd: '/workspace/repo',
        status: 'set',
        repositoryRoot: false,
      });

      assert.deepEqual(await tool(host).execute({ path: 'absent' }), {
        cwd: '/workspace/repo',
        status: 'refused',
        reason: 'missing',
        repositoryRoot: false,
      });

      assert.deepEqual(await tool(host).execute({ path: 'notes.txt' }), {
        cwd: '/workspace/repo',
        status: 'refused',
        reason: 'not-directory',
        repositoryRoot: false,
      });

      assert.equal(host.workspace.cwd(), '/workspace/repo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void test('refuses a path outside the workspace root', async () => {
    const root = await workspace('cwd-outside');
    const host = fakeHost({ localRoot: root });

    try {
      assert.deepEqual(await tool(host).execute({ path: 'repo/src' }), {
        cwd: '/workspace/repo/src',
        status: 'set',
        repositoryRoot: false,
      });

      assert.deepEqual(await tool(host).execute({ path: '../../../etc' }), {
        cwd: '/workspace/repo/src',
        status: 'refused',
        reason: 'outside',
        repositoryRoot: false,
      });

      assert.equal(host.workspace.cwd(), '/workspace/repo/src');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void test('reports a repository root with the note to load skills, and no note elsewhere', async () => {
    const atRoot = fakeHost({
      cwd: '/workspace/repo',
      repositoryRoots: ['/workspace/repo'],
    });

    assert.deepEqual(await tool(atRoot).execute({}), {
      cwd: '/workspace/repo',
      status: 'reported',
      repositoryRoot: true,
      note: repositoryNote,
    });

    const outside = fakeHost({
      cwd: '/workspace',
      repositoryRoots: ['/workspace/repo'],
    });

    assert.deepEqual(await tool(outside).execute({}), {
      cwd: '/workspace',
      status: 'reported',
      repositoryRoot: false,
    });
  });

  void test('a move into a repository root carries the note, and a move into its subdirectory does not', async () => {
    const host = fakeHost({ repositoryRoots: ['/workspace/repo'] });

    assert.deepEqual(await tool(host).execute({ path: 'repo' }), {
      cwd: '/workspace/repo',
      status: 'set',
      repositoryRoot: true,
      note: repositoryNote,
    });

    assert.deepEqual(await tool(host).execute({ path: 'src' }), {
      cwd: '/workspace/repo/src',
      status: 'set',
      repositoryRoot: false,
    });
  });

  void test('a refusal at a repository root keeps the directory and carries the note', async () => {
    const root = await workspace('cwd-refused-root');
    const host = fakeHost({
      localRoot: root,
      cwd: '/workspace/repo',
      repositoryRoots: ['/workspace/repo'],
    });

    try {
      assert.deepEqual(await tool(host).execute({ path: 'absent' }), {
        cwd: '/workspace/repo',
        status: 'refused',
        reason: 'missing',
        repositoryRoot: true,
        note: repositoryNote,
      });

      assert.equal(host.workspace.cwd(), '/workspace/repo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** The note the specification gives a result at a repository root, verbatim. */
const repositoryNote =
  'Remember to load the skills that match your task when working in a repository.';

/** The tool only asks the host about directories, so its sandbox is inert. */
const sandbox = { id: 'cwd-test', root: WORKSPACE_ROOT } as Sandbox;

const tool = (host: Host) => bindTool(factory, sandbox, host);

const workspace = async (name: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `doric-${name}-`));

  await mkdir(path.join(root, 'repo/src'), { recursive: true });

  await writeFile(path.join(root, 'repo/notes.txt'), 'notes\n', 'utf8');

  return root;
};
