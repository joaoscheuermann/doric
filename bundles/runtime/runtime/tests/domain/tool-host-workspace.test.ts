import assert from 'node:assert/strict';
import test from 'node:test';

import type { SandboxExecInput, SandboxExecResult } from 'sandbox';

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

/** One sandbox holding repository `alpha` and the plain directory `plain`. */
const sandboxWithRepository = (origin?: string) =>
  fakeSandbox({
    entries: [{ path: 'plain' }],
    repositories: [
      {
        path: 'alpha',
        git: {
          status: '# branch.head main',
          ...(origin === undefined ? {} : { origin }),
        },
      },
    ],
  });

/**
 * Wraps a scripted sandbox so a case can make the repository hint probe answer
 * otherwise, and records every hint probe's exec input.
 */
const probing = (sandbox: ReturnType<typeof fakeSandbox>) => {
  const state: {
    answer?: (input: SandboxExecInput) => Promise<SandboxExecResult>;
  } = {};
  const probes: SandboxExecInput[] = [];
  const scripted = sandbox.exec;
  sandbox.exec = async (input: SandboxExecInput) => {
    if (input.cmd[3] !== 'git-hint') return scripted(input);
    probes.push(input);
    return state.answer === undefined ? scripted(input) : state.answer(input);
  };
  return { sandbox, state, probes };
};

const exited = (exitCode: number | null): SandboxExecResult => ({
  exitCode,
  stdout: '',
  stderr: '',
  stdoutBytes: new Uint8Array(),
  stderrBytes: new Uint8Array(),
});

const rejecting = (error: Error) => async (): Promise<SandboxExecResult> => {
  throw error;
};

void test('a prompt reads its location with the repository hint of the directory it moved to', async () => {
  const seen: unknown[] = [];
  const finished = deferred<void>();
  const harness = createHarness({
    sandbox: {
      sandbox: sandboxWithRepository('git@github.com:owner/repo.git'),
    },
    execute: async ({ tools }) => {
      try {
        seen.push(await tools.workspace.setCwd('alpha'));
        seen.push(await tools.workspace.location());
        seen.push(await tools.workspace.setCwd('/workspace/plain'));
        seen.push(await tools.workspace.location());
      } finally {
        finished.resolve();
      }
      return 'done';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    await harness.service.threads.prompt(thread.id, 'Move');
    await finished.promise;

    assert.deepEqual(seen, [
      { status: 'set', cwd: '/workspace/alpha' },
      { cwd: '/workspace/alpha', repo: 'github' },
      { status: 'set', cwd: '/workspace/plain' },
      { cwd: '/workspace/plain' },
    ]);
    await harness.threadState(thread.id, 'ready');
  } finally {
    await harness.dispose();
  }
});

void test('a location whose hint probe fails keeps the stored hint and leaves the record unchanged', async () => {
  const { sandbox, state } = probing(sandboxWithRepository());
  const seen: unknown[] = [];
  const records: unknown[] = [];
  const finished = deferred<void>();
  let threadId = '';
  const harness = createHarness({
    sandbox: { sandbox },
    execute: async ({ tools }) => {
      try {
        for (const answer of [
          rejecting(new Error('Probe failed')),
          async () => exited(1),
          async () => exited(null),
        ]) {
          state.answer = answer;
          try {
            seen.push(await tools.workspace.location());
          } catch (error) {
            seen.push({ rejected: (error as Error).message });
          }
          const record = await harness.service.threads.find(threadId);
          records.push({ cwd: record?.cwd, cwdRepo: record?.cwdRepo });
        }
      } finally {
        state.answer = undefined;
        finished.resolve();
      }
      return 'done';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    threadId = thread.id;
    const moved = await harness.service.threads.setCwd(thread.id, 'alpha');
    assert.equal(moved.status, 'updated');
    if (moved.status !== 'updated') throw new Error('The move was refused');
    assert.equal(moved.thread.cwdRepo, 'git');

    await harness.service.threads.prompt(thread.id, 'Look');
    await finished.promise;

    const stored = { cwd: '/workspace/alpha', cwdRepo: 'git' };
    assert.deepEqual(seen, [
      { cwd: '/workspace/alpha', repo: 'git' },
      { cwd: '/workspace/alpha', repo: 'git' },
      { cwd: '/workspace/alpha', repo: 'git' },
    ]);
    assert.deepEqual(records, [stored, stored, stored]);
    await harness.threadState(thread.id, 'ready');
  } finally {
    await harness.dispose();
  }
});

void test('a move whose hint probe did not finish moves without a hint, and one whose probe failed does not move', async () => {
  const { sandbox, state, probes } = probing(sandboxWithRepository());
  const seen: unknown[] = [];
  const records: unknown[] = [];
  const finished = deferred<void>();
  let threadId = '';
  const harness = createHarness({
    sandbox: { sandbox },
    execute: async ({ tools }) => {
      try {
        for (const answer of [
          rejecting(new Error('Probe failed')),
          rejecting(new Error('Sandbox command timed out')),
          async () => exited(1),
          async () => exited(null),
        ]) {
          state.answer = undefined;
          await tools.workspace.setCwd('/workspace');
          state.answer = answer;
          try {
            seen.push(await tools.workspace.setCwd('alpha'));
          } catch (error) {
            seen.push({ rejected: (error as Error).message });
          }
          const record = await harness.service.threads.find(threadId);
          records.push({ cwd: record?.cwd, cwdRepo: record?.cwdRepo });
        }
      } finally {
        state.answer = undefined;
        finished.resolve();
      }
      return 'done';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    threadId = thread.id;

    await harness.service.threads.prompt(thread.id, 'Move');
    await finished.promise;

    assert.deepEqual(seen, [
      { rejected: 'Probe failed' },
      { rejected: 'Sandbox command timed out' },
      { status: 'set', cwd: '/workspace/alpha' },
      { status: 'set', cwd: '/workspace/alpha' },
    ]);
    assert.deepEqual(records, [
      { cwd: '/workspace', cwdRepo: undefined },
      { cwd: '/workspace', cwdRepo: undefined },
      { cwd: '/workspace/alpha', cwdRepo: undefined },
      { cwd: '/workspace/alpha', cwdRepo: undefined },
    ]);
    assert.ok(probes.length > 0);
    for (const probe of probes) assert.equal(probe.timeoutMs, 5000);
    await harness.threadState(thread.id, 'ready');
  } finally {
    await harness.dispose();
  }
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
