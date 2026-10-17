import assert from 'node:assert/strict';
import test from 'node:test';

import type { SandboxExecResult } from 'sandbox';

import type { ThreadEvent } from '../../src/contracts/model.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  createHarness,
  deferred,
  type Harness,
  type HarnessRun,
} from './support/harness.js';

/*
 * Steering a running prompt (runtime.threads/v1 1.3.0): the reader's input
 * reaches the prompt the reader saw running at the executor's next safe
 * point, falls back to the queue when that prompt is gone, and returns to the
 * front of the queue when the run never takes it in.
 */

const logOf = async (harness: Harness, id: string): Promise<ThreadEvent[]> => [
  ...((await harness.service.threads.events(id, 0))?.events ?? []),
];

/** What a scripted executor does at its safe point: takes and records steers. */
const takeSteerInputs = async (run: HarnessRun) => {
  const steers = (await run.session.steers?.()) ?? [];
  for (const _steer of steers)
    await run.session.record({ event: { type: 'agent.steered' } });
  return steers;
};

/** The texts of the steers a scripted run took in. */
const takeSteers = async (run: HarnessRun): Promise<readonly string[]> =>
  (await takeSteerInputs(run)).map((steer) => steer.prompt);

const thread = async (harness: Harness) => {
  const project = await harness.service.projects.create('Project');
  const created = await harness.service.threads.create(project.id, 'Thread');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  return created.thread.id;
};

void test('a steer reaches the running prompt at its safe point and never runs as a prompt of its own', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const safePoint = deferred();
  const ran: string[] = [];
  const taken: string[] = [];
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async (run) => {
      ran.push(run.job.prompt);
      if (run.job.prompt === 'work') {
        started.resolve();
        await safePoint.promise;
        taken.push(...(await takeSteers(run)));
      }
      return 'done';
    },
  });
  try {
    const id = await thread(harness);
    const work = await harness.service.threads.prompt(id, 'work');
    if (work.status !== 'accepted') throw new Error('Prompt unavailable');
    await started.promise;

    const steer = await harness.service.threads.steer(id, 'use the cache', {
      promptId: work.promptId,
    });
    if (steer.status !== 'steered') throw new Error('Steer unavailable');
    // A steer waiting for its prompt is not queued work.
    assert.deepEqual((await harness.service.threads.queue(id))?.items, []);

    safePoint.resolve();
    await harness.threadState(id, 'ready');

    assert.deepEqual(taken, ['use the cache']);
    assert.deepEqual(ran, ['work']);
    // The steer is closed under its own id, naming the prompt it steered.
    const steered = (await logOf(harness, id)).find(
      (event) => event.type === 'prompt.steered',
    );
    assert.equal(steered?.promptId, steer.promptId);
    assert.equal(
      (steered?.event as { promptId?: string } | undefined)?.promptId,
      work.promptId,
    );
    assert.deepEqual(await harness.stores.threads.unfinishedPrompts(id), []);
  } finally {
    safePoint.resolve();
    await harness.dispose();
  }
});

void test('a steer the run never takes in runs next, before inputs queued earlier', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const release = deferred();
  const drained = deferred();
  const ran: string[] = [];
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async ({ job }) => {
      ran.push(job.prompt);
      if (job.prompt === 'work') {
        started.resolve();
        await release.promise;
      }
      if (job.prompt === 'queued earlier') drained.resolve();
      return 'done';
    },
  });
  try {
    const id = await thread(harness);
    const work = await harness.service.threads.prompt(id, 'work');
    if (work.status !== 'accepted') throw new Error('Prompt unavailable');
    await started.promise;
    await harness.service.threads.prompt(id, 'queued earlier');
    assert.equal(
      (
        await harness.service.threads.steer(id, 'late steer', {
          promptId: work.promptId,
        })
      ).status,
      'steered',
    );

    release.resolve();
    await drained.promise;
    await harness.threadState(id, 'ready');

    assert.deepEqual(ran, ['work', 'late steer', 'queued earlier']);
  } finally {
    release.resolve();
    await harness.dispose();
  }
});

void test('a steer for a prompt that is no longer running is queued', {
  timeout: 5000,
}, async () => {
  const ran: string[] = [];
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async ({ job }) => {
      ran.push(job.prompt);
      return 'done';
    },
  });
  try {
    const id = await thread(harness);
    const work = await harness.service.threads.prompt(id, 'work');
    if (work.status !== 'accepted') throw new Error('Prompt unavailable');
    await harness.waitFor(() => ran.length === 1, 'the first run');
    await harness.threadState(id, 'ready');

    const steer = await harness.service.threads.steer(id, 'afterthought', {
      promptId: work.promptId,
    });

    assert.equal(steer.status, 'queued');
    await harness.waitFor(() => ran.length === 2, 'the queued steer');
    assert.deepEqual(ran, ['work', 'afterthought']);
  } finally {
    await harness.dispose();
  }
});

void test('a steer while the Thread is stopping waits in the paused queue', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const settle = deferred();
  const ran: string[] = [];
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async ({ job }) => {
      ran.push(job.prompt);
      if (job.prompt === 'work') {
        started.resolve();
        await settle.promise;
      }
      return 'done';
    },
  });
  try {
    const id = await thread(harness);
    const work = await harness.service.threads.prompt(id, 'work');
    if (work.status !== 'accepted') throw new Error('Prompt unavailable');
    await started.promise;
    await harness.service.threads.interrupt(id, work.promptId);

    const steer = await harness.service.threads.steer(id, 'too late', {
      promptId: work.promptId,
    });
    settle.resolve();
    await harness.threadState(id, 'ready');

    assert.equal(steer.status, 'queued');
    const queue = await harness.service.threads.queue(id);
    assert.equal(queue?.paused, true);
    assert.deepEqual(
      queue?.items.map((item) => item.preview),
      ['too late'],
    );
    assert.deepEqual(ran, ['work']);
  } finally {
    settle.resolve();
    await harness.dispose();
  }
});

void test('an interrupting steer aborts the current step and continues the same prompt with it', {
  timeout: 5000,
}, async () => {
  const started = deferred();
  const runs: { readonly promptId: string; readonly steers: string[] }[] = [];
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async (run) => {
      const entry = { promptId: run.job.id, steers: [] as string[] };
      runs.push(entry);
      entry.steers.push(...(await takeSteers(run)));
      if (runs.length === 1) {
        started.resolve();
        // A long step that only an abort ends.
        await new Promise<void>((resolve) =>
          run.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        run.signal?.throwIfAborted();
      }
      return 'done';
    },
  });
  try {
    const id = await thread(harness);
    const work = await harness.service.threads.prompt(id, 'work');
    if (work.status !== 'accepted') throw new Error('Prompt unavailable');
    await started.promise;

    const steer = await harness.service.threads.steer(id, 'stop that', {
      promptId: work.promptId,
      interrupt: true,
    });
    assert.equal(steer.status, 'steered');
    await harness.waitFor(() => runs.length === 2, 'the continued run');
    await harness.threadState(id, 'ready');

    assert.deepEqual(runs, [
      { promptId: work.promptId, steers: [] },
      { promptId: work.promptId, steers: ['stop that'] },
    ]);
    const log = await logOf(harness, id);
    const finished = log.filter(
      (event) =>
        event.promptId === work.promptId && event.type === 'prompt.finished',
    );
    assert.equal(finished.length, 1);
    assert.equal(
      (finished[0]?.event as { status?: string } | undefined)?.status,
      'completed',
    );
    assert.ok(!log.some((event) => event.type === 'prompt.paused'));
  } finally {
    await harness.dispose();
  }
});

void test('a background terminal result steers the prompt still running instead of queuing a turn', {
  timeout: 5000,
}, async () => {
  const terminalFinished = deferred<SandboxExecResult>();
  const ran: string[] = [];
  const taken: { readonly kind: string; readonly prompt: string }[] = [];
  const harness = createHarness({
    sandbox: {
      sandbox: {
        ...fakeSandbox(),
        start: async () => ({
          result: terminalFinished.promise,
          write: async () => undefined,
          resize: async () => undefined,
          terminate: async () => undefined,
        }),
      } as never,
    },
    execute: async (run) => {
      ran.push(run.job.prompt);
      await run.tools.terminal.run({
        command: 'npm test',
        cwd: '/workspace',
        timeoutMs: 0,
        background: true,
      });
      terminalFinished.resolve({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        stdoutBytes: new Uint8Array(),
        stderrBytes: new Uint8Array(),
      });
      // The prompt keeps working until the result reaches its safe point.
      await harness.waitFor(async () => {
        for (const steer of await takeSteerInputs(run))
          taken.push({ kind: steer.source.kind, prompt: steer.prompt });
        return taken.length > 0;
      }, 'the terminal steer');
      return 'done';
    },
  });
  try {
    const id = await thread(harness);
    await harness.service.threads.prompt(id, 'run the tests');
    await harness.waitFor(() => taken.length > 0, 'the steer');
    await harness.threadState(id, 'ready');

    assert.equal(taken[0]?.kind, 'terminal');
    assert.match(taken[0]?.prompt ?? '', /npm test/);
    assert.deepEqual(ran, ['run the tests']);
    assert.deepEqual(await harness.stores.threads.unfinishedPrompts(id), []);
  } finally {
    await harness.dispose();
  }
});
