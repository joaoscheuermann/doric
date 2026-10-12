import assert from 'node:assert/strict';
import test from 'node:test';

import type { CwdChange } from '../../src/contracts/index.js';
import { fakeSandbox } from '../support/sandbox.js';
import { createHarness, deferred } from './support/harness.js';

/*
 * The per-prompt Host facade's workspace namespace (design M10), reached by a
 * running prompt through runtime.workspace/v1: a move is a value per outcome,
 * a relative path resolves against the Thread's current directory, and a
 * refusal leaves the working directory where it was.
 */

const sandboxWithAlpha = () =>
  fakeSandbox({
    entries: [
      { path: 'alpha' },
      { path: 'alpha/src' },
      { path: 'alpha/README.md', content: 'x' },
    ],
  });

void test('a prompt moves its Thread directory and reports each refusal as a value', async () => {
  const moves: string[] = [];
  const outcomes: CwdChange[] = [];
  const cwds: string[] = [];
  const finished = deferred<void>();
  const harness = createHarness({
    sandbox: { sandbox: sandboxWithAlpha() },
    execute: async ({ tools }) => {
      for (const path of ['alpha', 'src', 'nowhere', '../README.md', '/etc']) {
        moves.push(path);
        outcomes.push(await tools.workspace.setCwd(path));
        cwds.push(await tools.workspace.cwd());
      }
      finished.resolve();
      return 'done';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    assert.equal(
      (await harness.service.threads.prompt(thread.id, 'Move')).status,
      'accepted',
    );
    await finished.promise;

    assert.deepEqual(moves, [
      'alpha',
      'src',
      'nowhere',
      '../README.md',
      '/etc',
    ]);
    assert.deepEqual(outcomes, [
      { status: 'set', cwd: '/workspace/alpha' },
      { status: 'set', cwd: '/workspace/alpha/src' },
      { status: 'missing' },
      { status: 'not-directory' },
      { status: 'outside' },
    ]);
    assert.deepEqual(cwds, [
      '/workspace/alpha',
      '/workspace/alpha/src',
      '/workspace/alpha/src',
      '/workspace/alpha/src',
      '/workspace/alpha/src',
    ]);
    await harness.threadState(thread.id, 'ready');
  } finally {
    await harness.dispose();
  }
});
