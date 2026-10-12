import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  promptFinishedEvent,
  qualifiedType,
} from '../../src/contracts/events.js';
import { leaseScopeMessage } from '../../src/contracts/lease.js';
import type { RuntimeNotice } from '../../src/contracts/runtime.js';
import { createHarness, deferred } from '../domain/support/harness.js';
import { fakeSandbox } from '../support/sandbox.js';

/*
 * The runtime's own contract behavior (design 57 §2.2, §2.5, §2.11, §2.12,
 * §4.8, §4.9): notices after their commit and in publication order, the boot
 * recovery and its summary, the lease-read scope rule, the observe hooks and
 * the qualified alias of every durable prompt.finished.
 */

void test('recover runs the boot sequence once and answers its summary', async () => {
  const harness = createHarness();
  const first = await harness.runtime.recover();
  assert.deepEqual(first, {
    interruptedThreads: 0,
    interruptedProjects: 0,
    resumedPrompts: 0,
  });
  assert.deepEqual(await harness.runtime.recover(), first);
  assert.deepEqual(
    harness.logs
      .filter(({ level }) => level === 'info')
      .map(({ message, fields }) => [message, fields]),
    [
      [
        'Project and thread reconciliation complete',
        { interruptedThreads: 0, interruptedProjects: 0 },
      ],
      ['Interrupted prompts resumed', { resumedPrompts: 0 }],
      ['Project sandbox recovery scheduled', undefined],
    ],
  );
  await harness.dispose();
});

void test('recover reconciles interrupted records and resumes the prompts the host owes', async () => {
  const harness = createHarness();
  const { stores } = harness;
  const { project } = await stores.projects.create(
    'Project',
    {
      configuration: {
        providers: [],
        models: { execution: { providerId: 'p', model: 'm' } },
        execution: { maxTurns: 1 },
      },
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    },
    'blue',
  );
  await stores.projects.setState(project.id, 'ready');
  const { thread } = await stores.threads.create(project.id, 'Thread');
  const promptId = randomUUID();
  await stores.threads.appendEvent(thread.id, promptId, {
    type: 'prompt.accepted',
    text: 'interrupted',
    source: { kind: 'user' },
  });
  await stores.threads.setState(thread.id, 'running', promptId);
  await stores.threads.appendEvent(thread.id, promptId, {
    type: 'prompt.started',
  });

  assert.deepEqual(await harness.runtime.recover(), {
    interruptedThreads: 1,
    interruptedProjects: 1,
    resumedPrompts: 1,
  });
  await harness.waitFor(
    async () =>
      (await harness.service.threads.find(thread.id))?.result?.promptId ===
      promptId,
  );
  await harness.dispose();
});

void test('watch delivers every notice after its commit, in publication order, until disposed', async () => {
  const harness = createHarness();
  const seen: RuntimeNotice[] = [];
  const watching = harness.runtime.watch((notice) => {
    seen.push(notice);
  });
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  const accepted = await harness.service.threads.prompt(thread.id, 'hello');
  assert.ok(accepted.status === 'accepted');
  await harness.waitFor(() =>
    seen.some(
      (notice) =>
        notice.kind === 'event' && notice.value.type === 'prompt.finished',
    ),
  );
  // Every event notice carries the stored event, in log order.
  const sequences = seen.flatMap((notice) =>
    notice.kind === 'event' && notice.value.threadId === thread.id
      ? [notice.value.sequence]
      : [],
  );
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => a - b),
  );
  const stored = (await harness.service.threads.events(thread.id, 0))?.events;
  assert.deepEqual(
    seen.flatMap((notice) =>
      notice.kind === 'event' && notice.value.threadId === thread.id
        ? [notice.value]
        : [],
    ),
    stored,
  );
  // The Project notice reports the committed record.
  assert.ok(
    seen.some(
      (notice) =>
        notice.kind === 'projectUpdated' && notice.value.state === 'ready',
    ),
  );
  watching.dispose();
  const count = seen.length;
  await harness.service.threads.rename(thread.id, 'Renamed');
  assert.equal(seen.length, count);
  await harness.dispose();
});

void test('a listener that throws is logged and never reaches the domain', async () => {
  const harness = createHarness();
  harness.runtime.watch(() => {
    throw new Error('listener failure');
  });
  const project = await harness.readyProject();
  assert.equal(
    (await harness.service.projects.find(project.id))?.state,
    'ready',
  );
  assert.ok(
    harness.logs.some(
      ({ level, message }) =>
        level === 'error' && message === 'Runtime notice listener failed',
    ),
  );
  await harness.dispose();
});

void test('lease reads need the scope of their Project or Thread', async () => {
  const harness = createHarness({
    sandbox: { sandbox: fakeSandbox() as never },
  });
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  const refused = { code: 'invalid_input', message: leaseScopeMessage };

  await assert.rejects(async () => harness.lease({}).files({}), refused);
  await assert.rejects(async () => harness.lease({}).ssh(), refused);
  await assert.rejects(
    async () => harness.lease({ projectId: project.id }).git(),
    refused,
  );
  await assert.rejects(
    async () => harness.lease({ threadId: thread.id }).resources(),
    refused,
  );
  assert.equal(
    (await harness.lease({ projectId: project.id }).resources()).status,
    'ready',
  );
  assert.equal(
    (await harness.lease({ threadId: thread.id }).git()).status,
    'ready',
  );
  await harness.dispose();
});

void test('the prompt-scoped contracts refuse a call whose prompt is not running', async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  const scope = {
    projectId: project.id,
    threadId: thread.id,
    promptId: randomUUID(),
  };
  const inactive = { message: 'Thread control is no longer active.' };
  const tools = harness.consumer.services;
  const { RuntimeThreadsV1 } = await import('../../src/contracts/threads.js');
  const { RuntimeWorkspaceV1 } = await import(
    '../../src/contracts/workspace.js'
  );
  await assert.rejects(
    async () => tools.use(RuntimeThreadsV1, scope).list(10),
    inactive,
  );
  await assert.rejects(
    async () => tools.use(RuntimeWorkspaceV1, scope).cwd(),
    inactive,
  );
  await assert.rejects(async () => harness.lease(scope).describe(), inactive);
  await harness.dispose();
});

void test('a Project fires its ready and closing hooks after each commit', async () => {
  const harness = createHarness();
  const project = await harness.readyProject();
  await harness.waitFor(() =>
    harness.hooks.some(({ hook }) => hook === 'onProjectReadyHook'),
  );
  await harness.service.projects.terminate(project.id);
  await harness.projectState(project.id, 'cancelled');
  await harness.waitFor(() =>
    harness.hooks.some(({ hook }) => hook === 'onProjectClosingHook'),
  );
  assert.deepEqual(harness.hooks, [
    { hook: 'onProjectReadyHook', input: { projectId: project.id } },
    { hook: 'onProjectClosingHook', input: { projectId: project.id } },
  ]);
  await harness.dispose();
});

void test('every durable prompt.finished keeps its type and validates as the qualified event', async () => {
  const removable = deferred();
  const harness = createHarness({
    execute: async ({ job, signal }) => {
      if (job.prompt === 'fail') throw new Error('failure');
      if (job.prompt === 'hold') {
        removable.resolve();
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        signal?.throwIfAborted();
      }
      return 'done';
    },
  });
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  const { service } = harness;
  await service.threads.prompt(thread.id, 'ok');
  await service.threads.prompt(thread.id, 'fail');
  const held = await service.threads.prompt(thread.id, 'hold');
  const removed = await service.threads.prompt(thread.id, 'removed');
  assert.ok(held.status === 'accepted' && removed.status === 'accepted');
  await removable.promise;
  assert.equal(
    await service.threads.removeQueued(thread.id, removed.promptId),
    'removed',
  );
  await service.threads.terminate(thread.id);
  await harness.threadState(thread.id, 'cancelled');
  const finished = (
    (await service.threads.events(thread.id, 0))?.events ?? []
  ).filter(({ type }) => type === 'prompt.finished');
  assert.deepEqual(
    finished.map(
      ({ event }) =>
        [
          (event as { status: string }).status,
          (event as { reason?: string }).reason,
        ] as const,
    ),
    [
      ['completed', undefined],
      ['failed', undefined],
      ['cancelled', 'queue_removed'],
      ['cancelled', undefined],
    ],
  );
  for (const { type, event } of finished) {
    assert.equal((event as { type: string }).type, 'prompt.finished');
    assert.equal(qualifiedType(type), promptFinishedEvent.type);
    const { type: _type, ...payload } = event as Record<string, unknown>;
    assert.ok(promptFinishedEvent.payload.safeParse(payload).success);
  }
  await harness.dispose();
});
