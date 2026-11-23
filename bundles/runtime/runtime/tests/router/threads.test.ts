// `runtime.threads/v1` over the router (phase 3, slice S46b, contract §2.2):
// the workspace operations answer what the kernel's `runtime.threads/v1`
// answers, the controls bind to the calling prompt's scope, `Instruct` names
// the router-stamped caller, `WatchThread` splits a snapshot over 3 MiB and
// resumes without duplicates, and `ViewThread` holds a view while open.
// Tests 31–40 of the slice.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { describe } from 'node:test';

import {
  create,
  type DescMessage,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Caller, CallScope } from 'bundle/contracts';

import type { ConfigurationValue } from '../../src/contracts/configuration.js';
import type { InputSource } from '../../src/contracts/model.js';
import {
  CreateThreadResponseSchema,
  EditQueuedResponseSchema,
  QueuedPromptSchema,
  ResumeResultSchema,
  PromptResultSchema,
  ThreadPageSchema,
  ThreadQueueSchema,
  type WatchThreadResponse,
  WatchThreadResponseSchema,
} from '../../src/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  type Thread,
  ThreadSchema,
} from '../../src/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { decode, runtimeOneofs } from '../../src/host/rpc/codec.js';
import {
  createHarness,
  defaultConfiguration,
  epoch,
} from '../domain/support/harness.js';
import { normalize } from '../support/capture-adapter.js';
import type { ScriptedRun } from '../support/executor.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  assertFails,
  collect,
  contractErrorOf,
  eventually,
  type Gate,
  gate,
  type Harness,
  harness,
  projectState,
  rejectionOf,
  seedThread,
  settle,
  started,
  within,
} from './support.js';

const unknownId = '00000000-0000-4000-8000-00000000ffff';

/** 3 MiB, the largest encoded snapshot item (contract §2.2). */
const snapshotMaxBytes = 3 * 1024 * 1024;
/** 4 MiB, the largest message the router carries. */
const routerMaxBytes = 4 * 1024 * 1024;

/** A routed answer as today's JSON, through the bundle's codec. */
const json = <D extends DescMessage>(
  schema: D,
  message: MessageShape<D> | undefined,
): unknown =>
  message === undefined ? null : decode(schema, message, runtimeOneofs);

const threadJson = (thread: Thread | undefined) => json(ThreadSchema, thread);

/** A kernel answer as JSON, `undefined` as `null`. */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null)) as unknown;

/** A few milliseconds, so two creations never share a `createdAt`. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Resolves when `held` opens or the run is stopped. */
const holdUntil = (held: Gate, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    void held.promise.then(resolve);
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

/** `openrouter` lists `m-1` (low) and `m-2` (low, high). */
const executionConfiguration = (): {
  configuration: ConfigurationValue;
  revision: number;
  updatedAt: string;
} => {
  const [openrouter] = defaultConfiguration.providers;
  assert.ok(openrouter !== undefined);

  return {
    configuration: {
      ...defaultConfiguration,
      providers: [
        {
          ...openrouter,
          models: [
            { name: 'm-1', reasonings: ['low'] },
            { name: 'm-2', reasonings: ['low', 'high'] },
          ],
        },
      ],
      models: {
        execution: { providerId: 'openrouter', model: 'm-1', effort: 'low' },
      },
    },
    revision: 1,
    updatedAt: epoch,
  };
};

/** A ready Project and a Thread in it, created through the routed RPCs. */
const readyThread = async (h: Harness, name = 'Thread') => {
  const { project } = await h.runtime().createProject({ name: 'Project' });
  assert.ok(project !== undefined);
  await projectState(h, project.id, 'ready');
  const created = await h.threads().createThread({
    projectId: project.id,
    name,
  });
  assert.equal(created.status, 'created');
  assert.ok(created.thread !== undefined);

  return { project, thread: created.thread };
};

/** The Thread as `Thread` answers it now. */
const threadOf = async (h: Harness, id: string) =>
  (await h.threads().thread({ id })).thread;

/** Waits until the Thread reads `state` through `Thread`. */
const threadState = (h: Harness, id: string, state: string) =>
  eventually(
    async () => (await threadOf(h, id))?.state === state,
    `Thread ${id} ${state}`,
  );

// ---------------------------------------------------------------------------
// Test 31: the reads and the creation, against the kernel

/** One sequence of Thread calls, as both sides answer it (today's JSON). */
interface ThreadCalls {
  readyProject(name: string): Promise<string>;
  createThread(
    projectId: string,
    name: string,
    parentThreadId?: string,
  ): Promise<{ status: string; thread?: { id: string } }>;
  thread(id: string): Promise<unknown>;
  storedThread(id: string): Promise<unknown>;
  threads(
    projectId: string,
    limit: number,
    cursor?: string,
    parentThreadId?: string,
  ): Promise<{ nextCursor?: string } | null>;
  projectThreads(projectId: string): Promise<unknown>;
}

const readScenario = async (calls: ThreadCalls) => {
  const answers: { step: string; answer: unknown }[] = [];
  const keep = (step: string, answer: unknown) => {
    answers.push({ step, answer: plain(answer) });
  };
  const projectId = await calls.readyProject('Threads');
  const alpha = await calls.createThread(projectId, 'Alpha');
  keep('create Alpha', alpha);
  await tick();
  const beta = await calls.createThread(projectId, 'Beta');
  keep('create Beta', beta);
  await tick();
  assert.ok(alpha.thread !== undefined && beta.thread !== undefined);
  const child = await calls.createThread(projectId, 'Child', alpha.thread.id);
  keep('create Child under Alpha', child);
  keep('create under unknown parent', await calls.createThread(projectId, 'Orphan', unknownId));
  keep('create in unknown project', await calls.createThread(unknownId, 'Lost'));
  keep('thread Alpha', await calls.thread(alpha.thread.id));
  keep('thread unknown', await calls.thread(unknownId));
  keep('stored Alpha', await calls.storedThread(alpha.thread.id));
  keep('stored unknown', await calls.storedThread(unknownId));
  const first = await calls.threads(projectId, 1);
  keep('page 1', first);
  keep('page 2', await calls.threads(projectId, 1, first?.nextCursor));
  keep('children of Alpha', await calls.threads(projectId, 10, undefined, alpha.thread.id));
  keep('threads of unknown project', await calls.threads(unknownId, 10));
  keep('project threads', await calls.projectThreads(projectId));
  keep('project threads of unknown', await calls.projectThreads(unknownId));

  return normalize(answers);
};

const routedReads = (h: Harness): ThreadCalls => ({
  readyProject: async (name) => {
    const { project } = await h.runtime().createProject({ name });
    assert.ok(project !== undefined);
    await projectState(h, project.id, 'ready');

    return project.id;
  },
  createThread: async (projectId, name, parentThreadId) =>
    json(
      CreateThreadResponseSchema,
      await h.threads().createThread({
        projectId,
        name,
        ...(parentThreadId === undefined ? {} : { parentThreadId }),
      }),
    ) as { status: string; thread?: { id: string } },
  thread: async (id) => threadJson((await h.threads().thread({ id })).thread),
  storedThread: async (id) =>
    threadJson((await h.threads().storedThread({ id })).thread),
  threads: async (projectId, limit, cursor, parentThreadId) =>
    json(
      ThreadPageSchema,
      (
        await h.threads().threads({
          projectId,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
        })
      ).threadPage,
    ) as { nextCursor?: string } | null,
  projectThreads: async (projectId) =>
    (await h.threads().projectThreads({ projectId })).threads.map(threadJson),
});

const kernelReads = (kernel: ReturnType<typeof createHarness>): ThreadCalls => ({
  readyProject: async (name) => (await kernel.readyProject(name)).id,
  createThread: (projectId, name, parentThreadId) =>
    kernel.threads.createThread({
      projectId,
      name,
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    }) as Promise<{ status: string; thread?: { id: string } }>,
  thread: (id) => kernel.threads.thread(id),
  storedThread: (id) => kernel.threads.storedThread(id),
  threads: async (projectId, limit, cursor, parentThreadId) =>
    ((await kernel.threads.threads({
      projectId,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    })) ?? null) as { nextCursor?: string } | null,
  projectThreads: (projectId) => kernel.threads.projectThreads(projectId),
});

// ---------------------------------------------------------------------------
// Test 34: the queue, against the kernel

/** The queue calls of one Thread; every answer as today's JSON. */
interface QueueCalls {
  readonly threadId: string;
  prompt(text: string): Promise<{ status: string; promptId?: string }>;
  state(state: string): Promise<void>;
  queue(): Promise<unknown>;
  queuedPrompt(promptId: string): Promise<{ revision?: number } | null>;
  editQueued(promptId: string, text: string, revision: number): Promise<unknown>;
  removeQueued(promptId: string): Promise<unknown>;
  pause(promptId: string): Promise<unknown>;
  resumeQueue(): Promise<unknown>;
}

const queueScenario = async (calls: QueueCalls, held: Gate) => {
  const answers: { step: string; answer: unknown }[] = [];
  const keep = (step: string, answer: unknown) => {
    answers.push({ step, answer: plain(answer) });
  };
  try {
    const running = await calls.prompt('hold');
    keep('prompt hold', running);
    await calls.state('running');
    const queued = await calls.prompt('second');
    keep('prompt second', queued);
    assert.ok(running.promptId !== undefined && queued.promptId !== undefined);
    keep('queue with second', await calls.queue());
    const prompt = await calls.queuedPrompt(queued.promptId);
    keep('queued second', prompt);
    keep('queued unknown', await calls.queuedPrompt(unknownId));
    const revision = prompt?.revision ?? 0;
    keep('edit at a stale revision', await calls.editQueued(queued.promptId, 'edited', revision + 1));
    keep('edit at its revision', await calls.editQueued(queued.promptId, 'edited', revision));
    keep('queued after edit', await calls.queuedPrompt(queued.promptId));
    keep('remove second', await calls.removeQueued(queued.promptId));
    keep('remove again', await calls.removeQueued(queued.promptId));
    keep('pause hold', await calls.pause(running.promptId));
    await calls.state('ready');
    keep('queue after pause', await calls.queue());
    held.open();
    keep('resume queue', await calls.resumeQueue());
    await calls.state('ready');
    keep('queue at the end', await calls.queue());
  } finally {
    held.open();
  }

  return normalize(answers);
};

const routedQueue = (h: Harness, threadId: string): QueueCalls => ({
  threadId,
  prompt: async (prompt) =>
    json(
      PromptResultSchema,
      (await h.threads().prompt({ id: threadId, prompt })).promptResult,
    ) as { status: string; promptId?: string },
  state: (state) => threadState(h, threadId, state),
  queue: async () =>
    json(ThreadQueueSchema, (await h.threads().queue({ id: threadId })).threadQueue),
  queuedPrompt: async (promptId) =>
    json(
      QueuedPromptSchema,
      (await h.threads().queuedPrompt({ id: threadId, promptId })).queuedPrompt,
    ) as { revision?: number } | null,
  editQueued: async (promptId, text, revision) =>
    json(
      EditQueuedResponseSchema,
      await h.threads().editQueued({ id: threadId, promptId, text, revision }),
    ),
  removeQueued: async (promptId) =>
    (await h.threads().removeQueued({ id: threadId, promptId }))
      .removeQueuedResult,
  pause: async (promptId) =>
    (await h.threads().pause({ id: threadId, promptId })).interruptResult,
  resumeQueue: async () =>
    json(
      ResumeResultSchema,
      (await h.threads().resumeQueue({ id: threadId })).resumeResult,
    ),
});

const kernelQueue = (
  kernel: ReturnType<typeof createHarness>,
  threadId: string,
): QueueCalls => ({
  threadId,
  prompt: (prompt) =>
    kernel.threads.prompt({ id: threadId, prompt }) as Promise<{
      status: string;
      promptId?: string;
    }>,
  state: (state) => kernel.threadState(threadId, state),
  queue: () => kernel.threads.queue(threadId),
  queuedPrompt: async (promptId) =>
    ((await kernel.threads.queuedPrompt({ id: threadId, promptId })) ??
      null) as { revision?: number } | null,
  editQueued: (promptId, text, revision) =>
    kernel.threads.editQueued({ id: threadId, promptId, text, revision }),
  removeQueued: (promptId) =>
    kernel.threads.removeQueued({ id: threadId, promptId }),
  pause: (promptId) => kernel.threads.pause({ id: threadId, promptId }),
  resumeQueue: () => kernel.threads.resumeQueue(threadId),
});

/** A script that holds the prompt `hold` until `held` opens or it is stopped. */
const holding =
  (held: Gate) =>
  async (run: ScriptedRun): Promise<string> => {
    if (run.job.prompt === 'hold') await holdUntil(held, run.signal);

    return 'done';
  };

// ---------------------------------------------------------------------------
// WatchThread helpers

/** The sequences an item of `WatchThread` carries, in order. */
const sequencesOf = (item: WatchThreadResponse): number[] =>
  item.item.case === 'snapshot'
    ? item.item.value.events.map(({ sequence }) => sequence)
    : item.item.case === 'event'
      ? [item.item.value.sequence]
      : [];

const encodedBytes = (item: WatchThreadResponse) =>
  toBinary(WatchThreadResponseSchema, item).byteLength;

describe('runtime.threads/v1', () => {
  test("31: CreateThread, Thread, StoredThread, Threads (paging, parentThreadId) and ProjectThreads answer what the kernel's runtime.threads/v1 answers", async (t) => {
    const h = await started(t);
    const kernel = createHarness();
    t.after(() => kernel.dispose());

    const routed = await readScenario(routedReads(h));
    const today = await readScenario(kernelReads(kernel));

    assert.deepEqual(routed, today);
  });

  test('32: RenameThread, SetThreadCwd, SetThreadExecution, ArchiveThread, RestoreThread and SetThreadPinned answer their status unions as the CEL rules require', async (t) => {
    const h = await started(t, {
      configuration: executionConfiguration,
      sandbox: {
        sandbox: fakeSandbox({
          entries: [{ path: 'alpha' }, { path: 'escape' }],
          escapes: ['escape'],
        }) as never,
      },
    });
    const { thread } = await readyThread(h);
    const threads = h.threads();

    const renamed = await threads.renameThread({ id: thread.id, name: 'Renamed' });
    assert.equal(renamed.thread?.name, 'Renamed');
    assert.equal(
      (await threads.renameThread({ id: unknownId, name: 'Nobody' })).thread,
      undefined,
    );

    const moved = await threads.setThreadCwd({ id: thread.id, cwd: 'alpha' });
    assert.equal(moved.status, 'updated');
    assert.equal(moved.thread?.id, thread.id);
    assert.equal(moved.change, undefined);
    // From `alpha`, `../escape` names the root's `escape`, which the sandbox
    // resolves outside the root.
    const refused = await threads.setThreadCwd({
      id: thread.id,
      cwd: '../escape',
    });
    assert.equal(refused.status, 'refused');
    assert.equal(refused.change?.status, 'outside');
    assert.equal(refused.thread, undefined);
    const missingCwd = await threads.setThreadCwd({ id: unknownId, cwd: 'alpha' });
    assert.equal(missingCwd.status, 'missing');
    assert.equal(missingCwd.thread, undefined);
    assert.equal(missingCwd.change, undefined);

    const invalid = await threads.setThreadExecution({
      id: thread.id,
      providerId: 'openrouter',
      model: 'm-1',
      effort: 'high',
    });
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.reason, 'effort');
    assert.equal(invalid.thread, undefined);
    assert.equal(invalid.message, undefined);
    const updated = await threads.setThreadExecution({
      id: thread.id,
      providerId: 'openrouter',
      model: 'm-2',
      effort: 'high',
    });
    assert.equal(updated.status, 'updated');
    assert.equal(updated.thread?.model, 'm-2');
    assert.equal(updated.thread?.effort, 'high');
    assert.equal(updated.reason, undefined);
    const missingExecution = await threads.setThreadExecution({
      id: unknownId,
      providerId: 'openrouter',
      model: 'm-1',
    });
    assert.equal(missingExecution.status, 'missing');
    assert.equal(missingExecution.thread, undefined);

    const archived = await threads.archiveThread({ id: thread.id });
    assert.equal(archived.status, 'archived');
    assert.ok((archived.batch ?? '').length > 0, 'a batch when archived');
    assert.deepEqual(
      archived.threads.map(({ id }) => id),
      [thread.id],
    );
    const again = await threads.archiveThread({ id: thread.id });
    assert.equal(again.status, 'already_archived');
    assert.equal(again.batch, undefined);
    assert.deepEqual(again.threads, []);

    const restored = await threads.restoreThread({ id: thread.id });
    assert.equal(restored.status, 'restored');
    assert.deepEqual(
      restored.threads.map(({ id }) => id),
      [thread.id],
    );
    const notArchived = await threads.restoreThread({ id: thread.id });
    assert.equal(notArchived.status, 'not_archived');
    assert.deepEqual(notArchived.threads, []);

    const pinned = await threads.setThreadPinned({ id: thread.id, pinned: true });
    assert.equal(pinned.thread?.pinned, true);
    assert.equal(
      (await threads.setThreadPinned({ id: unknownId, pinned: true })).thread,
      undefined,
    );
  });

  test('33: Prompt is accepted with a promptId, the executor runs under the prompt scope and the Thread passes running → ready', async (t) => {
    const held = gate();
    const scopes: ScriptedRun['scope'][] = [];
    const h = await started(t, {
      execute: async (run) => {
        scopes.push(run.scope);
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    t.after(() => held.open());
    const { project, thread } = await readyThread(h);

    const { promptResult } = await h
      .threads()
      .prompt({ id: thread.id, prompt: 'Fix it.' });

    assert.equal(promptResult?.status, 'accepted');
    const promptId = promptResult?.promptId;
    assert.ok(promptId !== undefined && promptId.length > 0);
    await eventually(() => scopes.length === 1, 'the executor run');
    assert.deepEqual(scopes[0], {
      projectId: project.id,
      threadId: thread.id,
      promptId,
    });
    assert.equal((await threadOf(h, thread.id))?.state, 'running');

    held.open();
    await threadState(h, thread.id, 'ready');
  });

  test("34: Queue, QueuedPrompt, EditQueued (revision conflict), RemoveQueued, Pause and ResumeQueue answer what the kernel's answer", async (t) => {
    const routedHeld = gate();
    const kernelHeld = gate();
    const h = await started(t, { execute: holding(routedHeld) });
    const kernel = createHarness({ execute: holding(kernelHeld) });
    t.after(() => kernel.dispose());
    const { thread } = await readyThread(h);
    const kernelProject = await kernel.readyProject();
    const kernelThread = await kernel.createThread(kernelProject.id);

    const routed = await queueScenario(routedQueue(h, thread.id), routedHeld);
    const today = await queueScenario(
      kernelQueue(kernel, kernelThread.id),
      kernelHeld,
    );

    assert.deepEqual(routed, today);
    const conflict = routed.find(
      ({ step }) => step === 'edit at a stale revision',
    );
    assert.deepEqual(conflict?.answer, { status: 'conflict' });
  });

  test('35: Spawn from a running prompt creates a direct child; the same call after the prompt finished fails thread_control_inactive', async (t) => {
    const held = gate();
    const h = await started(t, {
      configuration: executionConfiguration,
      execute: async (run) => {
        if (run.job.prompt === 'parent') await holdUntil(held, run.signal);

        return 'done';
      },
    });
    t.after(() => held.open());
    const { project, thread: parent } = await readyThread(h, 'Parent');
    const { promptResult } = await h
      .threads()
      .prompt({ id: parent.id, prompt: 'parent' });
    assert.equal(promptResult?.status, 'accepted');
    assert.ok(promptResult?.promptId !== undefined);
    await threadState(h, parent.id, 'running');
    const scope: CallScope = {
      projectId: project.id,
      threadId: parent.id,
      promptId: promptResult.promptId,
    };
    const controls = h.threads(scope);

    const spawned = await controls.spawn({ prompt: 'task' });

    assert.ok(spawned.threadId.length > 0 && spawned.promptId.length > 0);
    const child = await threadOf(h, spawned.threadId);
    assert.equal(child?.parentThreadId, parent.id);
    assert.equal(child?.projectId, project.id);
    assert.deepEqual(
      (await controls.list({ limit: 10 })).items.map(({ id }) => id),
      [spawned.threadId],
    );

    // An effort the configuration refuses for the parent's model `m-1`.
    const refused = contractErrorOf(
      await rejectionOf(
        controls.spawn({ prompt: 'task', options: { effort: 'high' } }),
      ),
    );
    assert.equal(refused.code, 'invalid_execution');
    assert.deepEqual(
      (refused.details as { readonly issue?: unknown } | undefined)?.issue,
      'effort',
    );

    held.open();
    await threadState(h, parent.id, 'ready');

    const failure = await rejectionOf(controls.spawn({ prompt: 'late' }));
    assert.ok(failure instanceof ConnectError);
    assert.equal(failure.code, Code.FailedPrecondition);
    const inactive = contractErrorOf(failure);
    assert.equal(inactive.code, 'thread_control_inactive');
    assert.equal(inactive.message, 'Thread control is no longer active.');
  });

  test('36: Instruct records the source {kind: bundle, bundleId} of the router-stamped caller', async (t) => {
    const sources: InputSource[] = [];
    const h = await started(t, {
      execute: async (run) => {
        sources.push(run.job.source);

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const caller: Caller = {
      bundleId: 'coding-workflow',
      version: '1.0.0',
      generation: 1,
    };

    const { steerResult } = await h
      .threads(undefined, caller)
      .instruct({ id: thread.id, prompt: 'Follow the workflow.', reason: 'review' });

    assert.ok(
      steerResult?.status === 'queued' || steerResult?.status === 'steered',
      steerResult?.status,
    );
    await eventually(() => sources.length === 1, 'the instructed run');
    assert.deepEqual(sources[0], {
      kind: 'bundle',
      bundleId: 'coding-workflow',
      reason: 'review',
    });
  });

  test('37: WatchThread over more than 3 MiB of events: a snapshot under 3 MiB, the rest as consecutive event items before any live item, each item under 4 MiB', async (t) => {
    const h = harness();
    t.after(() => h.stop());
    const { thread } = await seedThread(h);
    const promptId = randomUUID();
    const text = 'x'.repeat(256 * 1024);
    const total = 14;
    for (let index = 0; index < total; index += 1)
      await h.seed.threads.appendEvent(thread.id, promptId, {
        type: 'note',
        index,
        text,
      });
    await h.start();
    const controller = new AbortController();
    t.after(() => controller.abort());

    const items = collect(
      h
        .threads()
        .watchThread(
          { threadId: thread.id, afterSequence: 0 },
          { signal: controller.signal },
        ),
    );
    await eventually(
      () => items.items.flatMap(sequencesOf).length >= total || items.ended(),
      'every stored event',
      10_000,
    );
    assert.equal(items.error(), undefined);
    await h.threads().renameThread({ id: thread.id, name: 'Live' });
    await eventually(
      () => items.items.some(({ item }) => item.case === 'updated'),
      'the live updated item',
    );

    const [first] = items.items;
    assert.equal(first?.item.case, 'snapshot');
    assert.ok(first.item.case === 'snapshot');
    const snapshot = first.item.value;
    assert.equal(snapshot.threadId, thread.id);
    assert.ok(encodedBytes(first) < snapshotMaxBytes, 'the snapshot under 3 MiB');
    assert.ok(snapshot.events.length > 0, 'the snapshot holds events');
    assert.ok(snapshot.events.length < total, 'the snapshot was split');
    // The snapshot holds every event that fits: one more would cross 3 MiB.
    const next = items.items[1];
    assert.ok(next?.item.case === 'event', 'the rest follow as event items');
    const fuller = create(WatchThreadResponseSchema, {
      item: {
        case: 'snapshot',
        value: { ...snapshot, events: [...snapshot.events, next.item.value] },
      },
    });
    assert.ok(encodedBytes(fuller) >= snapshotMaxBytes, 'the snapshot is full');

    const liveIndex = items.items.findIndex(({ item }) => item.case === 'updated');
    const beforeLive = items.items.slice(0, liveIndex);
    assert.deepEqual(
      beforeLive.flatMap(sequencesOf),
      Array.from({ length: total }, (_, index) => index + 1),
    );
    assert.ok(
      beforeLive.slice(1).every(({ item }) => item.case === 'event'),
      'only event items between the snapshot and the first live item',
    );
    for (const item of items.items)
      assert.ok(encodedBytes(item) < routerMaxBytes, 'every item under 4 MiB');
  });

  test('38: WatchThread resumed with afterSequence = the last sequence received yields no duplicate sequence', async (t) => {
    // Each run is held until the Thread reads `running`, so the wait for
    // `ready` that follows sees the run settle rather than the state before
    // it started, and `lastSequence` is the run's final sequence.
    let held = gate();
    t.after(() => held.open());
    const h = await started(t, {
      execute: async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const settledPrompt = async (prompt: string) => {
      held = gate();
      await h.threads().prompt({ id: thread.id, prompt });
      await threadState(h, thread.id, 'running');
      held.open();
      await threadState(h, thread.id, 'ready');
    };
    await settledPrompt('one');
    const firstLast = (await threadOf(h, thread.id))?.lastSequence ?? 0;
    assert.ok(firstLast > 0, 'the first prompt wrote events');

    const controller = new AbortController();
    const first = collect(
      h
        .threads()
        .watchThread(
          { threadId: thread.id, afterSequence: 0 },
          { signal: controller.signal },
        ),
    );
    await eventually(
      () => first.items.flatMap(sequencesOf).includes(firstLast),
      'the first watch to reach the last sequence',
    );
    const received = first.items.flatMap(sequencesOf);
    const last = Math.max(...received);
    controller.abort();
    await within(first.done, 'the cancelled watch to end');

    await settledPrompt('two');
    const finalLast = (await threadOf(h, thread.id))?.lastSequence ?? 0;
    assert.ok(finalLast > last, 'the second prompt wrote events');

    const resumed = new AbortController();
    t.after(() => resumed.abort());
    const second = collect(
      h
        .threads()
        .watchThread(
          { threadId: thread.id, afterSequence: last },
          { signal: resumed.signal },
        ),
    );
    await eventually(
      () => second.items.flatMap(sequencesOf).includes(finalLast),
      'the resumed watch to reach the last sequence',
    );
    await settle();

    const resumedSequences = second.items.flatMap(sequencesOf);
    assert.equal(second.items[0]?.item.case, 'snapshot');
    assert.deepEqual(
      resumedSequences,
      Array.from({ length: finalLast - last }, (_, index) => last + 1 + index),
    );
    assert.equal(
      new Set([...received, ...resumedSequences]).size,
      received.length + resumedSequences.length,
      'no sequence twice across both watches',
    );
  });

  test('39: ViewThread fails NOT_FOUND for a missing Thread; for an existing one it yields one viewing item and holds the view until cancelled', async (t) => {
    const h = await started(t);
    const { thread } = await readyThread(h);

    const missing = collect(h.threads().viewThread({ threadId: unknownId }));
    await within(missing.done, 'the missing view to end');
    const failure = missing.error();
    assert.ok(failure instanceof ConnectError, 'the view failed');
    assert.equal(failure.code, Code.NotFound);
    assert.equal(contractErrorOf(failure).code, 'not_found');
    assert.deepEqual(missing.items, []);

    const controller = new AbortController();
    const view = collect(
      h
        .threads()
        .viewThread({ threadId: thread.id }, { signal: controller.signal }),
    );
    await view.waitFor(1, 'the viewing item');
    assert.equal(view.items[0]?.kind, 'viewing');
    assert.equal(view.items[0]?.threadId, thread.id);

    await settle();
    assert.equal(view.items.length, 1, 'one item and nothing else');
    assert.equal(view.ended(), false, 'the view is held while open');

    controller.abort();
    await within(view.done, 'the cancelled view to end');
    assert.equal(view.items.length, 1);
  });

  test('40: EnqueueTerminalResult delivers a terminal-sourced prompt; FailTerminalResult closes the Thread with terminal_result_failed', async (t) => {
    const jobs: { prompt: string; source: InputSource }[] = [];
    const h = await started(t, {
      execute: async (run) => {
        jobs.push({ prompt: run.job.prompt, source: run.job.source });

        return 'done';
      },
    });
    const { thread } = await readyThread(h);
    const { promptResult } = await h
      .threads()
      .prompt({ id: thread.id, prompt: 'start a terminal' });
    assert.ok(promptResult?.promptId !== undefined);
    await threadState(h, thread.id, 'ready');
    await eventually(() => jobs.length === 1, 'the first run');

    await h.threads().enqueueTerminalResult({
      threadId: thread.id,
      promptId: promptResult.promptId,
      terminalId: 'terminal-1',
      text: 'exit 0',
    });

    await eventually(() => jobs.length === 2, 'the terminal-sourced run');
    assert.deepEqual(jobs[1]?.source, {
      kind: 'terminal',
      terminalId: 'terminal-1',
      promptId: promptResult.promptId,
    });
    assert.ok(jobs[1]?.prompt.includes('exit 0'), jobs[1]?.prompt);
    await threadState(h, thread.id, 'ready');

    await h.threads().failTerminalResult({ threadId: thread.id });

    await threadState(h, thread.id, 'failed');
    assert.equal(
      (await threadOf(h, thread.id))?.errorCode,
      'terminal_result_failed',
    );
  });

  test('a control without a prompt scope fails thread_control_inactive', async (t) => {
    const h = await started(t);

    await assertFails(
      h.threads().list({ limit: 1 }),
      'thread_control_inactive',
    );
  });
});
