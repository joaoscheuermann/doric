import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import type { Host } from 'host';
import type { Sandbox } from 'sandbox';

import factory from '../tools/cwd.js';
import { fakeHost, WORKSPACE_ROOT } from './fake-sandbox.js';

describe('cwd tool', () => {
  test('reports the current directory without a path', async () => {
    const host = fakeHost({ cwd: '/workspace/repo' });

    assert.deepEqual(await tool(host).execute({}), {
      cwd: '/workspace/repo',
      status: 'reported',
    });

    assert.deepEqual(await tool(host).execute({ path: '' }), {
      cwd: '/workspace/repo',
      status: 'reported',
    });

    // A blank path names no directory either, exactly as the HTTP route reads
    // one, so it can never move into a directory named with spaces.
    assert.deepEqual(await tool(host).execute({ path: '   ' }), {
      cwd: '/workspace/repo',
      status: 'reported',
    });
    assert.equal(host.workspace.cwd(), '/workspace/repo');
  });

  test('moves to a relative path resolved against the current directory', async () => {
    const host = fakeHost();

    assert.deepEqual(await tool(host).execute({ path: 'repo' }), {
      cwd: '/workspace/repo',
      status: 'set',
    });

    assert.deepEqual(await tool(host).execute({ path: 'src' }), {
      cwd: '/workspace/repo/src',
      status: 'set',
    });

    assert.deepEqual(await tool(host).execute({ path: '..' }), {
      cwd: '/workspace/repo',
      status: 'set',
    });

    assert.equal(host.workspace.cwd(), '/workspace/repo');
  });

  test('moves to an absolute path and reports the resolved directory', async () => {
    const host = fakeHost();

    assert.deepEqual(
      await tool(host).execute({ path: '/workspace/repo/src' }),
      {
        cwd: '/workspace/repo/src',
        status: 'set',
      },
    );

    assert.deepEqual(
      await tool(host).execute({ path: '/workspace/repo/./src/../src/' }),
      { cwd: '/workspace/repo/src', status: 'set' },
    );

    assert.equal(host.workspace.cwd(), '/workspace/repo/src');
  });

  test('refuses a path that is missing or is not a directory', async () => {
    const root = await workspace('cwd-refused');
    const host = fakeHost({ localRoot: root });

    try {
      assert.deepEqual(await tool(host).execute({ path: 'repo' }), {
        cwd: '/workspace/repo',
        status: 'set',
      });

      assert.deepEqual(await tool(host).execute({ path: 'absent' }), {
        cwd: '/workspace/repo',
        status: 'refused',
        reason: 'missing',
      });

      assert.deepEqual(await tool(host).execute({ path: 'notes.txt' }), {
        cwd: '/workspace/repo',
        status: 'refused',
        reason: 'not-directory',
      });

      assert.equal(host.workspace.cwd(), '/workspace/repo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a path outside the workspace root', async () => {
    const root = await workspace('cwd-outside');
    const host = fakeHost({ localRoot: root });

    try {
      assert.deepEqual(await tool(host).execute({ path: 'repo/src' }), {
        cwd: '/workspace/repo/src',
        status: 'set',
      });

      assert.deepEqual(await tool(host).execute({ path: '../../../etc' }), {
        cwd: '/workspace/repo/src',
        status: 'refused',
        reason: 'outside',
      });

      assert.equal(host.workspace.cwd(), '/workspace/repo/src');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** The tool only asks the host about directories, so its sandbox is inert. */
const sandbox = { id: 'cwd-test', root: WORKSPACE_ROOT } as Sandbox;

const tool = (host: Host) => factory(sandbox, host);

const workspace = async (name: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `doric-${name}-`));

  await mkdir(path.join(root, 'repo/src'), { recursive: true });

  await writeFile(path.join(root, 'repo/notes.txt'), 'notes\n', 'utf8');

  return root;
};
