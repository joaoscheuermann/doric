import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { ThreadEvent } from '../../src/contracts/model.js';
import type { ThreadStore } from '../../src/host/store/types.js';
import { postgresBackend } from '../store/support.js';
import { messagesOf, testHistoryFormat } from '../support/executor.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  createHarness,
  defaultConfiguration,
  deferred,
  type HarnessRun,
} from './support/harness.js';

/*
 * Ported from agents/doric tests/workspace-restart.test.ts (design 57 §13.1,
 * stage 5 "Restart"; §13.2: PostgreSQL-backed): a runtime booting over the
 * durable records a previous host left, on the PostgreSQL storage. The boot
 * is `runtime/v1.recover()`, today's reconcile and resume sequence.
 */

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
void test('recovery dispatches persisted edits and never makes started or machine inputs editable', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const texts: string[] = [];
  const host = await restart({
    execute: async ({ job }) => {
      texts.push(job.prompt);
      return 'done';
    },
  });
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread } = await host.threads.create(project.id, 'Thread');
    await host.threads.appendEvent(thread.id, randomUUID(), {
      type: 'queue.paused',
    });
    const promptId = randomUUID();
    await host.threads.appendEvents(thread.id, promptId, [
      {
        type: 'prompt.accepted',
        text: 'Original',
        source: { kind: 'user' },
        queued: true,
      },
      { type: 'prompt.queued' },
      { type: 'prompt.edited', text: 'Persisted edit' },
    ]);
    const started = randomUUID();
    await host.threads.appendEvents(thread.id, started, [
      {
        type: 'prompt.accepted',
        text: 'Started',
        source: { kind: 'user' },
        queued: true,
      },
      { type: 'prompt.started' },
      { type: 'prompt.paused', reason: 'reader_stopped' },
    ]);
    const machine = randomUUID();
    await host.threads.appendEvent(thread.id, machine, {
      type: 'prompt.accepted',
      text: 'Result',
      // A delegated result as the runtime writes it (the store keeps only a
      // complete source; see 57-WP-R1).
      source: {
        kind: 'result',
        threadId: randomUUID(),
        promptId: randomUUID(),
        requestPromptId: randomUUID(),
      },
      queued: true,
    });
    await host.service.resumeInterrupted();
    const detail = await host.service.threads.queuedPrompt(thread.id, promptId);
    assert.equal(detail?.text, 'Persisted edit');
    assert.equal(detail?.editable, true);
    assert.ok(detail);
    assert.equal(
      (await host.service.threads.queuedPrompt(thread.id, started))?.editable,
      false,
    );
    assert.equal(
      (await host.service.threads.editQueued(thread.id, started, 'Too late', 0))
        .status,
      'not_editable',
    );
    assert.equal(
      (await host.service.threads.editQueued(thread.id, machine, 'Not mine', 0))
        .status,
      'not_editable',
    );
    const updated = await host.service.threads.editQueued(
      thread.id,
      promptId,
      'Final edit',
      detail.revision,
    );
    assert.equal(updated.status, 'updated');
    assert.equal(
      (await host.threads.unfinishedPrompts(thread.id)).find(
        (item) => item.promptId === promptId,
      )?.text,
      'Final edit',
    );
    await host.service.threads.removeQueued(thread.id, started);
    await host.service.threads.removeQueued(thread.id, machine);
    await host.service.threads.resumeQueue(thread.id);
    await until(() => texts.length === 1);
    assert.deepEqual(texts, ['Final edit']);
  } finally {
    await host.close();
  }
});

void test('removing a delegated queued input returns one cancellation result to its paused parent', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const host = await restart();
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread: parent } = await host.threads.create(project.id, 'Parent');
    const { thread: child } = await host.threads.create(
      project.id,
      'Child',
      parent.id,
    );
    const promptId = randomUUID();
    const requestPromptId = randomUUID();
    for (const thread of [parent, child])
      await host.threads.appendEvent(thread.id, randomUUID(), {
        type: 'queue.paused',
      });
    await host.threads.appendEvent(child.id, promptId, {
      type: 'prompt.accepted',
      text: 'delegated',
      queued: true,
      source: {
        kind: 'parent',
        threadId: parent.id,
        promptId: requestPromptId,
      },
    });
    await host.service.resumeInterrupted();
    assert.equal(
      await host.service.threads.removeQueued(child.id, promptId),
      'removed',
    );
    assert.equal(
      await host.service.threads.removeQueued(child.id, promptId),
      'removed',
    );
    const queue = await host.threads.queue(parent.id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.items.length, 1);
    assert.deepEqual(queue?.items[0].source, {
      kind: 'result',
      threadId: child.id,
      promptId,
      requestPromptId,
    });
    const receipt = (await host.threads.eventsAfter(parent.id, 0)).find(
      (event) => event.type === 'prompt.accepted',
    );
    assert.ok(receipt);
    assert.match((receipt.event as { text: string }).text, /cancelled/);
    assert.deepEqual(host.ran, []);
  } finally {
    await host.close();
  }
});

void test('removed queued and paused prompts stay closed when replayed after recovery', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const host = await restart();
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread } = await host.threads.create(project.id, 'Thread');
    const current = randomUUID();
    const remove = randomUUID();
    const keep = randomUUID();
    await host.threads.appendEvent(thread.id, current, {
      type: 'prompt.accepted',
      text: 'current',
      source: { kind: 'user' },
      queued: false,
    });
    await host.threads.appendEvent(thread.id, current, {
      type: 'prompt.paused',
      reason: 'reader_stopped',
    });
    await host.threads.appendEvent(thread.id, current, {
      type: 'queue.paused',
    });
    for (const [promptId, text] of [
      [remove, 'remove'],
      [keep, 'keep'],
    ]) {
      await host.threads.appendEvent(thread.id, promptId, {
        type: 'prompt.accepted',
        text,
        source: { kind: 'user' },
        queued: true,
      });
    }
    await host.service.resumeInterrupted();
    assert.equal(
      await host.service.threads.removeQueued(thread.id, remove),
      'removed',
    );
    assert.equal(
      await host.service.threads.removeQueued(thread.id, current),
      'removed',
    );
    await host.threads.reconcile();
    assert.deepEqual(
      (await host.threads.unfinishedPrompts(thread.id)).map(
        (prompt) => prompt.promptId,
      ),
      [keep],
    );
    const queue = await host.threads.queue(thread.id);
    assert.equal(queue?.current, undefined);
    assert.equal(queue?.paused, true);
    assert.deepEqual(
      queue?.items.map((item) => item.promptId),
      [keep],
    );
    assert.deepEqual(host.ran, []);
  } finally {
    await host.close();
  }
});

void test('boot queues an exhausted child result without reopening its paused parent', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const host = await restart();
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread: parent } = await host.threads.create(project.id, 'Parent');
    const { thread: child } = await host.threads.create(
      project.id,
      'Child',
      parent.id,
    );
    const promptId = randomUUID();
    await host.threads.appendEvent(parent.id, randomUUID(), {
      type: 'queue.paused',
    });
    await host.threads.appendEvent(child.id, promptId, {
      type: 'prompt.accepted',
      text: 'delegated work',
      source: { kind: 'parent', threadId: parent.id, promptId: randomUUID() },
    });
    for (const attempt of [1, 2])
      await host.threads.appendEvent(child.id, promptId, {
        type: 'prompt.resumed',
        attempt,
      });
    await host.threads.appendEvent(child.id, promptId, {
      type: 'prompt.paused',
      reason: 'host_restarted',
    });
    assert.equal(await host.service.resumeInterrupted(), 0);
    const queue = await host.threads.queue(parent.id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.items.length, 1);
    assert.equal(queue?.items[0]?.source.kind, 'result');
    assert.equal(queue?.items[0]?.label, 'Subthread · Child');
    assert.deepEqual(host.ran, []);
  } finally {
    await host.close();
  }
});

void test('boot preserves the interrupted input before results and human prompts queued during its pause', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const finished = deferred();
  const host = await restart({
    execute: async ({ job }) => {
      if (job.prompt === 'second queued input') finished.resolve();
      return 'done';
    },
  });
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread } = await host.threads.create(project.id, 'Thread');
    const interrupted = randomUUID();
    const pending = randomUUID();
    await host.threads.appendEvent(thread.id, interrupted, {
      type: 'prompt.accepted',
      text: 'interrupted work',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(thread.id, interrupted, {
      type: 'agent.started',
    });
    await host.threads.appendEvent(thread.id, pending, {
      type: 'prompt.accepted',
      text: 'pending result',
      source: {
        kind: 'terminal',
        terminalId: randomUUID(),
        promptId: interrupted,
      },
    });
    await host.threads.appendEvent(thread.id, interrupted, {
      type: 'queue.paused',
    });
    await host.threads.appendEvent(thread.id, interrupted, {
      type: 'prompt.paused',
      reason: 'reader_stopped',
    });
    const queued = [randomUUID(), randomUUID()];
    for (const [index, id] of queued.entries()) {
      await host.threads.appendEvents(thread.id, id, [
        {
          type: 'prompt.accepted',
          text: index === 0 ? 'first queued input' : 'second queued input',
          source: { kind: 'user' },
          queued: true,
        },
        { type: 'prompt.queued' },
      ]);
    }
    await host.threads.reconcile();
    assert.equal(await host.service.resumeInterrupted(), 0);
    await host.service.recoverProjects();
    const queue = await host.service.threads.queue(thread.id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.resumable?.promptId, interrupted);
    assert.deepEqual(
      queue?.items.map((item) => item.promptId),
      [pending, ...queued],
    );
    assert.deepEqual(host.ran, []);
    assert.equal(
      (await host.service.threads.resumeQueue(thread.id)).status,
      'resumed',
    );
    await finished.promise;
    assert.deepEqual(host.ran, [interrupted, pending, ...queued]);
    assert.equal((await host.threads.queue(thread.id))?.paused, false);
  } finally {
    await host.close();
  }
});

void test('durably rejects a paused prompt superseded by new user input', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const host = await restart();
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread } = await host.threads.create(project.id, 'Thread');
    const old = randomUUID();
    const newer = randomUUID();
    await host.threads.appendEvent(thread.id, old, {
      type: 'prompt.accepted',
      text: 'old work',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(thread.id, old, {
      type: 'prompt.paused',
      reason: 'host_stopped',
    });
    await host.threads.appendEvent(thread.id, newer, {
      type: 'prompt.accepted',
      text: 'new work',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(thread.id, newer, {
      type: 'prompt.finished',
      text: 'done',
      status: 'completed',
      source: { kind: 'user' },
    });
    assert.deepEqual(await host.service.threads.resume(thread.id, old), {
      status: 'unknown_prompt',
    });
    assert.equal(await host.service.resumeInterrupted(), 0);
    assert.equal(host.ran.length, 0);
  } finally {
    await host.close();
  }
});

void test('delivers an exhausted delegated prompt to its parent exactly once', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const host = await restart();
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread: parent } = await host.threads.create(project.id, 'Parent');
    const { thread: child } = await host.threads.create(
      project.id,
      'Child',
      parent.id,
    );
    const promptId = randomUUID();
    const requestPromptId = randomUUID();
    await host.threads.appendEvent(child.id, promptId, {
      type: 'prompt.accepted',
      text: 'delegated work',
      source: {
        kind: 'parent',
        threadId: parent.id,
        promptId: requestPromptId,
      },
    });
    for (const attempt of [1, 2])
      await host.threads.appendEvent(child.id, promptId, {
        type: 'prompt.resumed',
        attempt,
      });
    await host.threads.reconcile();
    await host.projects.reconcile();
    assert.equal(await host.service.resumeInterrupted(), 1);
    await until(
      async () => (await host.threads.record(parent.id))?.result !== undefined,
    );
    // recover() runs once per runtime: a second call answers the first
    // summary and delivers nothing again.
    assert.equal(await host.service.resumeInterrupted(), 1);
    const accepted = (await host.threads.eventsAfter(parent.id, 0)).filter(
      ({ type }) => type === 'prompt.accepted',
    );
    assert.equal(accepted.length, 1);
    assert.deepEqual((accepted[0].event as { source: unknown }).source, {
      kind: 'result',
      threadId: child.id,
      promptId,
      requestPromptId,
    });
    assert.equal(
      (await host.threads.record(child.id))?.result?.status,
      'failed',
    );
  } finally {
    await host.close();
  }
});

/** The configuration snapshot a Project captures when it is created. */
const snapshot = {
  configuration: defaultConfiguration,
  revision: 1,
  updatedAt: new Date(0).toISOString(),
};

/**
 * A host booting over the durable records a previous one left: the real
 * stores on PostgreSQL and the real runtime, with the sandbox and the
 * execution standing in as the case needs them.
 */
const restart = async (
  options: {
    readonly execute?: (run: HarnessRun) => Promise<string>;
    readonly sandboxReady?: Promise<void>;
  } = {},
) => {
  assert.ok(connectionString);
  const backend = await postgresBackend();
  /** The prompts that reached execution, in the order they did. */
  const ran: string[] = [];
  const execute = options.execute ?? (async () => 'done');
  const harness = createHarness({
    backend,
    sandbox: {
      acquire: async () => {
        await options.sandboxReady;
        return {
          sandbox: fakeSandbox(),
          release: async () => undefined,
        } as never;
      },
    },
    execute: async (value) => {
      ran.push(value.job.id);
      return execute(value);
    },
  });
  return {
    projects: harness.stores.projects,
    threads: harness.stores.threads,
    service: harness.service,
    runtime: harness.runtime,
    acquisitions: {
      map: <T>(read: (value: { readonly identity: string }) => T) =>
        harness.sandbox.acquired.map((identity) => read({ identity })),
    },
    ran,
    close: async () => {
      await harness.dispose();
      await backend.close();
    },
  };
};

/** Prompt events in order; queue notifications belong to Thread dispatch. */
const eventsOf = async (
  threads: ThreadStore,
  threadId: string,
  promptId: string,
): Promise<readonly ThreadEvent[]> =>
  (await threads.eventsAfter(threadId, 0)).filter(
    (event) => event.promptId === promptId && !event.type.startsWith('queue.'),
  );

/** The event a run that completes leaves, as this host writes it. */
const completed = {
  type: 'prompt.finished',
  status: 'completed',
  text: 'done',
  source: { kind: 'user' },
};

/** Waits for the runs a resume starts, which the host runs in the background. */
const until = async (
  condition: () => boolean | Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('The resumed runs never arrived.');
};

void test('boot restores idle Projects without rerunning prompts or reviving terminal Projects', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const ready = deferred();
  const host = await restart({ sandboxReady: ready.promise });
  try {
    const { project } = await host.projects.create('Idle', snapshot, 'blue');
    const owner = await host.threads.create(project.id, 'Idle thread');
    const paused = await host.threads.create(project.id, 'Manually paused');
    const finished = randomUUID();
    await host.threads.appendEvent(owner.thread.id, finished, {
      type: 'prompt.accepted',
      text: 'done',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(owner.thread.id, finished, completed);
    const stopped = randomUUID();
    await host.threads.appendEvent(paused.thread.id, stopped, {
      type: 'prompt.accepted',
      text: 'pause',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(paused.thread.id, stopped, {
      type: 'prompt.paused',
      reason: 'reader_stopped',
    });
    for (const state of ['failed', 'cancelled', 'cancelling'] as const) {
      const closed = await host.projects.create(state, snapshot, 'green');
      await host.projects.setState(closed.project.id, state);
    }
    await host.threads.reconcile();
    await host.projects.reconcile();
    assert.equal(await host.service.resumeInterrupted(), 0);
    await host.service.recoverProjects();
    await host.service.recoverProjects();
    assert.deepEqual(
      host.acquisitions.map((value) => value.identity),
      [project.id],
    );
    assert.equal(
      (await host.service.threads.git(owner.thread.id)).status,
      'pending',
    );
    assert.equal(
      (await host.service.threads.branches(owner.thread.id)).status,
      'pending',
    );
    assert.deepEqual(host.ran, []);
    ready.resolve();
    await until(
      async () => (await host.projects.record(project.id))?.state === 'ready',
    );
    assert.equal(
      (await host.service.threads.git(owner.thread.id)).status,
      'ready',
    );
    assert.equal(
      (await host.service.threads.branches(owner.thread.id)).status,
      'ready',
    );
    assert.deepEqual(host.ran, []);
    assert.equal(
      (await host.threads.unfinishedPrompts()).find(
        (prompt) => prompt.promptId === stopped,
      )?.paused,
      'reader_stopped',
    );
  } finally {
    ready.resolve();
    await host.close();
  }
});

void test('boot prioritizes owed prompts before idle Projects and leaves paused work alone', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const host = await restart();
  try {
    // What a crashed host left behind: a Project that needs a sandbox again,
    // and Threads whose prompts were accepted against it.
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const owner = await host.threads.create(project.id, 'Thread');
    const other = await host.threads.create(project.id, 'Other');
    const { project: idle } = await host.projects.create(
      'Idle project',
      snapshot,
      'green',
    );
    const idleThread = await host.threads.create(idle.id, 'Thread');

    // A run the restart interrupted: accepted, started, never paused.
    const interrupted = randomUUID();
    await host.threads.appendEvent(owner.thread.id, interrupted, {
      type: 'prompt.accepted',
      text: 'finish the work',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(owner.thread.id, interrupted, {
      type: 'agent.started',
      model: 'test-model',
      input: 'finish the work',
    });
    // A prompt the crash caught between its acceptance and its first run.
    const queued = randomUUID();
    await host.threads.appendEvent(owner.thread.id, queued, {
      type: 'prompt.accepted',
      text: 'and then this',
      source: { kind: 'user' },
    });
    // A prompt the reader stopped: only the reader takes that one up again.
    const stopped = randomUUID();
    await host.threads.appendEvent(other.thread.id, stopped, {
      type: 'prompt.accepted',
      text: 'the reader stopped this',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(other.thread.id, stopped, {
      type: 'agent.started',
      model: 'test-model',
      input: 'the reader stopped this',
    });
    await host.threads.appendEvent(other.thread.id, stopped, {
      type: 'prompt.paused',
      reason: 'reader_stopped',
    });
    // A prompt that finished: nothing is owed for it.
    const finished = randomUUID();
    await host.threads.appendEvent(other.thread.id, finished, {
      type: 'prompt.accepted',
      text: 'already done',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(other.thread.id, finished, {
      type: 'prompt.finished',
      status: 'completed',
      text: 'done',
      source: { kind: 'user' },
    });
    const closed = await eventsOf(host.threads, other.thread.id, finished);
    // The idle Project holds only a finished prompt, so it owes nothing.
    const done = randomUUID();
    await host.threads.appendEvent(idleThread.thread.id, done, {
      type: 'prompt.accepted',
      text: 'nothing owed',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(idleThread.thread.id, done, {
      type: 'prompt.finished',
      status: 'completed',
      text: 'done',
      source: { kind: 'user' },
    });
    for (const thread of [
      owner.thread.id,
      other.thread.id,
      idleThread.thread.id,
    ]) {
      await host.threads.setState(thread, 'running', undefined, 'original');
    }

    // The boot: reconcile, then take up what the host owes.
    await host.threads.reconcile();
    await host.projects.reconcile();
    const resumed = await host.service.resumeInterrupted();
    await host.service.recoverProjects();
    await until(
      async () =>
        (await host.threads.record(owner.thread.id))?.result?.promptId ===
        queued,
    );

    assert.equal(resumed, 2, 'the two owed prompts are re-enqueued');
    // Both ran, in the order the log accepted them, each under its own prompt and
    // each opening its own next attempt.
    assert.deepEqual(host.ran, [interrupted, queued]);
    assert.deepEqual(
      (await eventsOf(host.threads, owner.thread.id, interrupted)).map(
        ({ event }) => event,
      ),
      [
        {
          type: 'prompt.accepted',
          text: 'finish the work',
          source: { kind: 'user' },
        },
        {
          type: 'agent.started',
          model: 'test-model',
          input: 'finish the work',
        },
        { type: 'prompt.paused', reason: 'host_restarted' },
        { type: 'prompt.resumed', attempt: 1 },
        { type: 'prompt.started' },
        completed,
      ],
    );
    assert.deepEqual(
      (await eventsOf(host.threads, owner.thread.id, queued)).map(
        ({ event }) => event,
      ),
      [
        {
          type: 'prompt.accepted',
          text: 'and then this',
          source: { kind: 'user' },
        },
        { type: 'prompt.resumed', attempt: 1 },
        { type: 'prompt.started' },
        completed,
      ],
    );
    // The reader's own stop is left for the reader, and the finished prompt is
    // untouched.
    assert.deepEqual(
      (await eventsOf(host.threads, other.thread.id, stopped)).map(
        ({ type }) => type,
      ),
      ['prompt.accepted', 'agent.started', 'prompt.paused'],
    );
    assert.deepEqual(
      await eventsOf(host.threads, other.thread.id, finished),
      closed,
    );
    // Owed work gets capacity first; idle Projects also return as themselves.
    assert.deepEqual(
      host.acquisitions.map(({ identity }) => identity),
      [project.id, idle.id],
    );
    await until(
      async () => (await host.projects.record(idle.id))?.state === 'ready',
    );
  } finally {
    await host.close();
  }
});

void test('continues a resumed prompt from the history it had already written', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const read: unknown[][] = [];
  const host = await restart({
    execute: async ({ session }) => {
      read.push([...(await messagesOf(session.history))]);
      return 'continued';
    },
  });
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread } = await host.threads.create(project.id, 'Thread');
    const callId = 'call-1';
    const promptId = randomUUID();
    await host.threads.appendEvent(thread.id, promptId, {
      type: 'prompt.accepted',
      text: 'finish the work',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(thread.id, promptId, {
      type: 'agent.started',
      model: 'local',
      input: 'finish the work',
    });
    // The turn boundary the host records before a run reads its history, and
    // exactly what a run stopped in the middle of a tool then leaves behind:
    // its input, the assistant turn that asked for the tool, and that tool's
    // own result, all persisted as the run advanced.
    const history = [
      { role: 'user', content: '# User request\n\nfinish the work' },
      {
        role: 'assistant',
        content: 'Inspecting.',
        toolCalls: [{ id: callId, name: 'inspect', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: callId, content: 'observed' },
    ];
    await host.threads.saveCheckpoint(thread.id, {
      format: testHistoryFormat,
      parts: { meta: { checkpoints: { [promptId]: 0 } } },
    });
    await host.threads.saveHistory(thread.id, {
      format: testHistoryFormat,
      parts: { messages: history },
    });
    await host.threads.setState(thread.id, 'running', undefined, 'original');

    const resumed = (await host.runtime.recover()).resumedPrompts;
    assert.equal(resumed, 1);
    await until(
      async () =>
        (await host.threads.record(thread.id))?.result?.promptId === promptId,
    );

    // The run continued from where the last one stopped: the history it had
    // already written is what its session reads, and the run completed.
    assert.deepEqual(read, [history]);
    assert.deepEqual(
      (await eventsOf(host.threads, thread.id, promptId)).at(-1)?.event,
      { ...completed, text: 'continued' },
    );
  } finally {
    await host.close();
  }
});

void test('closes a prompt the host interrupted three times and still honours the reader', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  const host = await restart();
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread } = await host.threads.create(project.id, 'Thread');

    // A prompt the host has already taken up twice, interrupted once more: the
    // attempt a boot would make is the third interruption, over its budget.
    const exhausted = randomUUID();
    await host.threads.appendEvent(thread.id, exhausted, {
      type: 'prompt.accepted',
      text: 'keeps dying',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(thread.id, exhausted, {
      type: 'agent.started',
      model: 'test-model',
      input: 'keeps dying',
    });
    for (const attempt of [1, 2]) {
      await host.threads.appendEvent(thread.id, exhausted, {
        type: 'prompt.paused',
        reason: 'host_stopped',
      });
      await host.threads.appendEvent(thread.id, exhausted, {
        type: 'prompt.resumed',
        attempt,
      });
    }
    // A prompt the reader stopped, after the host had taken it up twice: the
    // budget is the host's own rule, so this one is still the reader's.
    const reader = randomUUID();
    await host.threads.appendEvent(thread.id, reader, {
      type: 'prompt.accepted',
      text: 'the reader paused this',
      source: { kind: 'user' },
    });
    for (const attempt of [1, 2]) {
      await host.threads.appendEvent(thread.id, reader, {
        type: 'prompt.resumed',
        attempt,
      });
    }
    await host.threads.appendEvent(thread.id, reader, {
      type: 'prompt.paused',
      reason: 'reader_stopped',
    });
    await host.threads.setState(thread.id, 'running');

    await host.threads.reconcile();
    await host.projects.reconcile();
    assert.equal(
      await host.service.resumeInterrupted(),
      0,
      'the host resumes nothing it has stopped taking up',
    );

    // The prompt is closed as a failure, in the shape a failed run leaves, with
    // the reason the reader has to read.
    assert.deepEqual(
      (await eventsOf(host.threads, thread.id, exhausted))
        .slice(-3)
        .map(({ event }) => event),
      [
        { type: 'prompt.paused', reason: 'host_restarted' },
        {
          type: 'agent.failed',
          error: {
            name: 'ResumeExhaustedError',
            code: 'resume_exhausted',
            message:
              'A execução foi interrompida três vezes por reinício do host e não foi ' +
              'retomada de novo. O trabalho pode estar incompleto; mande o prompt ' +
              'novamente para continuar.',
          },
        },
        {
          type: 'prompt.finished',
          status: 'failed',
          text: 'The prompt failed.',
          source: { kind: 'user' },
        },
      ],
    );
    const record = await host.threads.record(thread.id);
    assert.equal(record?.result?.status, 'failed');
    assert.equal(record?.result?.promptId, exhausted);
    assert.deepEqual(host.ran, [], 'nothing was resumed');

    // The reader's own resume is not capped: the prompt is still unfinished and
    // the reader is the one asking.
    const resumed = await host.service.threads.resume(thread.id, reader);
    assert.ok(resumed.status === 'resumed');
    assert.equal(resumed.thread.id, thread.id);
    await until(
      async () =>
        (await host.threads.record(thread.id))?.result?.promptId === reader,
    );
    assert.deepEqual(
      (await eventsOf(host.threads, thread.id, reader)).map(
        ({ event }) => event,
      ),
      [
        {
          type: 'prompt.accepted',
          text: 'the reader paused this',
          source: { kind: 'user' },
        },
        { type: 'prompt.resumed', attempt: 1 },
        { type: 'prompt.resumed', attempt: 2 },
        { type: 'prompt.paused', reason: 'reader_stopped' },
        { type: 'prompt.resumed', attempt: 3 },
        { type: 'prompt.started' },
        completed,
      ],
    );
  } finally {
    await host.close();
  }
});

void test('resumes one reader-paused prompt on demand, bringing its Project back', {
  skip: connectionString === undefined,
  timeout: 10_000,
}, async () => {
  // The run is held open, so the prompt is still the Thread's own work when the
  // reader asks for it a second time.
  const running = deferred();
  const host = await restart({
    execute: async () => {
      await running.promise;
      return 'done';
    },
  });
  try {
    const { project } = await host.projects.create('Project', snapshot, 'blue');
    const { thread } = await host.threads.create(project.id, 'Thread');
    const promptId = randomUUID();
    await host.threads.appendEvent(thread.id, promptId, {
      type: 'prompt.accepted',
      text: 'paused by its reader',
      source: { kind: 'user' },
    });
    await host.threads.appendEvent(thread.id, promptId, {
      type: 'agent.started',
      model: 'test-model',
      input: 'paused by its reader',
    });
    await host.threads.appendEvent(thread.id, promptId, {
      type: 'prompt.paused',
      reason: 'reader_stopped',
    });
    await host.threads.setState(thread.id, 'ready');
    await host.projects.reconcile();
    await host.threads.reconcile();

    const resumed = await host.service.threads.resume(thread.id, promptId);
    assert.ok(resumed.status === 'resumed');
    assert.equal(resumed.thread.id, thread.id);
    await until(() => host.ran.length === 1);
    // The prompt is the Thread's own running work now, so asking for it again
    // cannot queue the same turn twice.
    assert.deepEqual(await host.service.threads.resume(thread.id, promptId), {
      status: 'busy',
    });
    running.resolve();
    await until(
      async () =>
        (await host.threads.record(thread.id))?.result?.promptId === promptId,
    );

    assert.deepEqual(
      (await eventsOf(host.threads, thread.id, promptId)).map(
        ({ event }) => event,
      ),
      [
        {
          type: 'prompt.accepted',
          text: 'paused by its reader',
          source: { kind: 'user' },
        },
        {
          type: 'agent.started',
          model: 'test-model',
          input: 'paused by its reader',
        },
        { type: 'prompt.paused', reason: 'reader_stopped' },
        { type: 'prompt.resumed', attempt: 1 },
        { type: 'prompt.started' },
        completed,
      ],
    );
    // The Project came back for its own prompt, with its own identity.
    assert.deepEqual(
      host.acquisitions.map(({ identity }) => identity),
      [project.id],
    );
    // Only a prompt this Thread holds unfinished is a resume target, and a
    // Thread the host does not hold is not one either.
    assert.deepEqual(
      await host.service.threads.resume(thread.id, randomUUID()),
      { status: 'unknown_prompt' },
    );
    assert.deepEqual(
      await host.service.threads.resume(randomUUID(), promptId),
      { status: 'missing' },
    );
  } finally {
    await host.close();
  }
});
