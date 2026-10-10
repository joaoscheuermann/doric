import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContractError } from 'bundle/contracts';

import type {
  Project,
  ProjectWatchItem,
  Terminal,
  TerminalWatchItem,
  Thread,
  ThreadEvent,
  ThreadWatchItem,
} from '../../src/contracts/index.js';
import { createNotices } from '../../src/host/domain/notices.js';
import {
  createWatches,
  type WatchReads,
} from '../../src/host/services/watches.js';
import { createHarness, deferred } from '../domain/support/harness.js';

/*
 * The remote watches (stage 9 R-STREAM): the transport socket suite
 * (bundles/transport/tests/sockets.test.ts) ported to the stream methods. The
 * durable reads are the boundary a case controls; the notices are the
 * runtime's own publisher. The last cases run the real runtime through its
 * contracts.
 */

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';
const project: Project = {
  id: projectId,
  name: 'Project',
  state: 'ready',
  configRevision: 1,
  createdAt: '',
  updatedAt: '',
};
const thread: Thread = {
  id: threadId,
  projectId,
  name: 'Thread',
  state: 'ready',
  lastSequence: 2,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
};
const terminal: Terminal = {
  id: 'terminal-1',
  projectId,
  threadId,
  origin: 'user',
  command: 'bash',
  cwd: '/workspace',
  startedAt: '',
  timeoutMs: null,
  state: 'running',
  pty: true,
};
const event = (sequence: number): ThreadEvent => ({
  projectId,
  threadId,
  promptId,
  sequence,
  type: 'text.delta',
  event: { type: 'text.delta', delta: `part-${sequence}` },
  createdAt: '',
});

/** The watches over controllable reads, with the runtime's notice publisher. */
const setup = (reads: Partial<WatchReads> = {}) => {
  const errors: string[] = [];
  const notices = createNotices({
    error: (message: string) => {
      errors.push(message);
    },
  } as Parameters<typeof createNotices>[0]);
  const watches = createWatches({
    notices,
    reads: {
      thread: async () => thread,
      eventsAfter: async (_id, afterSequence) =>
        [event(1), event(2)].filter((value) => value.sequence > afterSequence),
      project: async () => project,
      projectThreads: async () => [thread],
      terminals: async () => [],
      ...reads,
    },
  });
  const { publisher } = notices;
  const required = <T>(method: T | undefined): T => {
    if (method === undefined) throw new Error('The publisher lacks a method.');
    return method;
  };
  return {
    watches,
    errors,
    publisher: {
      ...publisher,
      terminalUpdated: required(publisher.terminalUpdated),
      terminalOutput: required(publisher.terminalOutput),
      terminalRemoved: required(publisher.terminalRemoved),
    },
  };
};

/** A listener that records every item and the end. */
const recorder = <T>() => {
  const items: T[] = [];
  const ended: (ContractError | undefined)[] = [];
  const waiters: { readonly check: () => boolean; resolve(): void }[] = [];
  const settle = () => {
    for (const waiter of [...waiters]) {
      if (waiter.check()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  return {
    items,
    ended,
    listener: {
      next: (item: T) => {
        items.push(item);
        settle();
      },
      end: (error?: ContractError) => {
        ended.push(error);
        settle();
      },
    },
    /** Resolves once `check` holds. */
    until: (check: () => boolean) =>
      new Promise<void>((resolve) => {
        if (check()) resolve();
        else waiters.push({ check, resolve });
      }),
  };
};

const kinds = (items: readonly ThreadWatchItem[]) =>
  items.map((item) =>
    item.kind === 'event' ? `event:${item.event.sequence}` : item.kind,
  );

void test('a thread watch replays ordered durable history then live events', async () => {
  const { watches, publisher } = setup();
  const seen = recorder<ThreadWatchItem>();
  const watch = watches.thread({ threadId, afterSequence: 0 }, seen.listener);
  await seen.until(() => seen.items.length === 1);
  assert.deepEqual(seen.items[0], {
    kind: 'snapshot',
    threadId,
    projectId,
    project,
    thread,
    events: [event(1), event(2)],
  });
  publisher.event(event(3));
  assert.deepEqual(seen.items[1], { kind: 'event', event: event(3) });
  watch.dispose();
});

void test('a thread watch answers an unknown Thread with nulls', async () => {
  const { watches } = setup({
    thread: async () => undefined,
    eventsAfter: async () => [],
  });
  const seen = recorder<ThreadWatchItem>();
  watches.thread({ threadId, afterSequence: 0 }, seen.listener);
  await seen.until(() => seen.items.length === 1);
  assert.deepEqual(seen.items, [
    {
      kind: 'snapshot',
      threadId,
      projectId: null,
      project: null,
      thread: null,
      events: [],
    },
  ]);
});

void test('a thread watch deduplicates exclusive replay and orders out-of-order live events', async () => {
  const gate = deferred<readonly ThreadEvent[]>();
  const { watches, publisher } = setup({ eventsAfter: () => gate.promise });
  const seen = recorder<ThreadWatchItem>();
  watches.thread({ threadId, afterSequence: 1 }, seen.listener);
  publisher.event(event(3));
  publisher.event(event(5));
  publisher.event(event(4));
  gate.resolve([event(2), event(3)]);
  await seen.until(() => seen.items.length === 3);
  publisher.threadUpdated(thread);
  assert.deepEqual(kinds(seen.items), [
    'snapshot',
    'event:4',
    'event:5',
    'updated',
  ]);
  const snapshot = seen.items[0];
  assert.equal(snapshot?.kind, 'snapshot');
  assert.deepEqual(
    snapshot.kind === 'snapshot'
      ? snapshot.events.map((value) => value.sequence)
      : [],
    [2, 3],
  );
});

void test('a thread watch holds a gap until the missing event arrives', async () => {
  const { watches, publisher } = setup();
  const seen = recorder<ThreadWatchItem>();
  watches.thread({ threadId, afterSequence: 0 }, seen.listener);
  await seen.until(() => seen.items.length === 1);
  publisher.event(event(4));
  assert.deepEqual(kinds(seen.items), ['snapshot']);
  publisher.event(event(3));
  assert.deepEqual(kinds(seen.items), ['snapshot', 'event:3', 'event:4']);
});

void test('a thread watch buffers lifecycle notices until the snapshot is delivered', async () => {
  const gate = deferred<readonly ThreadEvent[]>();
  const { watches, publisher } = setup({ eventsAfter: () => gate.promise });
  const seen = recorder<ThreadWatchItem>();
  watches.thread({ threadId, afterSequence: 0 }, seen.listener);
  publisher.threadUpdated({ ...thread, state: 'cancelled' });
  publisher.threadDeleted(projectId, threadId);
  assert.deepEqual(seen.items, []);
  gate.resolve([]);
  await seen.until(() => seen.items.length === 3);
  assert.deepEqual(kinds(seen.items), ['snapshot', 'updated', 'deleted']);
  assert.deepEqual(seen.items[2], { kind: 'deleted', projectId, threadId });
});

void test('a failed replay ends the watch with the sanitized error and nothing else', async () => {
  const { watches, publisher } = setup({
    eventsAfter: async () => {
      throw new Error('secret');
    },
  });
  const seen = recorder<ThreadWatchItem>();
  watches.thread({ threadId, afterSequence: 0 }, seen.listener);
  await seen.until(() => seen.ended.length === 1);
  assert.equal(seen.ended[0]?.code, 'replay_failed');
  assert.equal(seen.ended[0]?.message, 'The snapshot could not be loaded.');
  publisher.threadUpdated(thread);
  publisher.event(event(3));
  assert.deepEqual(seen.items, []);
  assert.equal(seen.ended.length, 1);
});

void test('a disposed watch delivers nothing, even when its read settles later', async () => {
  const gate = deferred<readonly ThreadEvent[]>();
  const { watches, publisher } = setup({ eventsAfter: () => gate.promise });
  const seen = recorder<ThreadWatchItem>();
  const watch = watches.thread({ threadId, afterSequence: 0 }, seen.listener);
  publisher.threadUpdated(thread);
  watch.dispose();
  gate.reject(new Error('private database error'));
  await new Promise((resolve) => setImmediate(resolve));
  publisher.event(event(3));
  assert.deepEqual(seen.items, []);
  assert.deepEqual(seen.ended, []);
});

void test('a project watch snapshots the tree and buffers its updates', async () => {
  const gate = deferred<readonly Thread[]>();
  const { watches, publisher } = setup({
    projectThreads: () => gate.promise,
    terminals: async () => [terminal],
  });
  const seen = recorder<ProjectWatchItem>();
  watches.project({ projectId }, seen.listener);
  const child = { ...thread, id: promptId, parentThreadId: threadId };
  publisher.threadUpdated(child);
  publisher.projectDeleted(projectId);
  gate.resolve([thread]);
  await seen.until(() => seen.items.length === 3);
  assert.deepEqual(seen.items, [
    {
      kind: 'snapshot',
      projectId,
      project,
      threads: [thread],
      terminals: [terminal],
    },
    { kind: 'thread-updated', thread: child },
    { kind: 'project-deleted', projectId },
  ]);
});

void test('a project watch sees only its own Project and Threads', async () => {
  const { watches, publisher } = setup();
  const seen = recorder<ProjectWatchItem>();
  watches.project({ projectId }, seen.listener);
  await seen.until(() => seen.items.length === 1);
  publisher.projectUpdated({ ...project, id: promptId });
  publisher.threadUpdated({ ...thread, projectId: promptId });
  publisher.threadDeleted(promptId, threadId);
  publisher.projectUpdated({ ...project, name: 'Renamed' });
  publisher.threadDeleted(projectId, threadId);
  assert.deepEqual(seen.items.slice(1), [
    { kind: 'project-updated', project: { ...project, name: 'Renamed' } },
    { kind: 'thread-deleted', projectId, threadId },
  ]);
});

void test('a terminal watch buffers lifecycle notices but never output', async () => {
  const gate = deferred<readonly Terminal[]>();
  const { watches, publisher } = setup({ terminals: () => gate.promise });
  const seen = recorder<TerminalWatchItem>();
  watches.terminals(projectId, seen.listener);
  const output = (data: string, offset: number) =>
    publisher.terminalOutput({
      projectId,
      threadId,
      terminalId: terminal.id,
      data,
      offset,
    });
  publisher.terminalUpdated(terminal);
  // Output published before the snapshot is dropped: a client reads the
  // bounded terminal snapshot instead.
  output('lost', 4);
  publisher.terminalRemoved({
    projectId,
    threadId,
    terminalId: terminal.id,
  });
  gate.resolve([terminal]);
  await seen.until(() => seen.items.length === 3);
  output('kept', 8);
  assert.deepEqual(seen.items, [
    { kind: 'snapshot', projectId, terminals: [terminal] },
    { kind: 'updated', terminal },
    { kind: 'removed', projectId, threadId, terminalId: terminal.id },
    {
      kind: 'output',
      output: {
        projectId,
        threadId,
        terminalId: terminal.id,
        data: 'kept',
        offset: 8,
      },
    },
  ]);
});

void test('a listener that fails does not stop the other watches', async () => {
  const { watches, publisher } = setup();
  const seen = recorder<ThreadWatchItem>();
  watches.thread({ threadId, afterSequence: 2 }, (item) => {
    if (item.kind === 'event') throw new Error('window gone');
  });
  watches.thread({ threadId, afterSequence: 2 }, seen.listener);
  await seen.until(() => seen.items.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  publisher.event(event(3));
  assert.deepEqual(kinds(seen.items), ['snapshot', 'event:3']);
});

void test('the runtime contracts stream a real Thread, its Project and its terminals', async () => {
  const harness = createHarness();
  try {
    const created = await harness.readyProject();
    const child = await harness.createThread(created.id);
    const threadItems = recorder<ThreadWatchItem>();
    const projectItems = recorder<ProjectWatchItem>();
    const terminalItems = recorder<TerminalWatchItem>();
    const watches = [
      harness.threads.watchThread(
        { threadId: child.id, afterSequence: 0 },
        threadItems.listener,
      ),
      harness.runtime.watchProject(
        { projectId: created.id },
        projectItems.listener,
      ),
      harness.terminals.watchProject(created.id, terminalItems.listener),
    ];
    await threadItems.until(() => threadItems.items.length === 1);
    await projectItems.until(() => projectItems.items.length === 1);
    await terminalItems.until(() => terminalItems.items.length === 1);
    assert.deepEqual(threadItems.items[0], {
      kind: 'snapshot',
      threadId: child.id,
      projectId: created.id,
      project: await harness.runtime.project(created.id),
      thread: await harness.stores.threads.record(child.id),
      events: [],
    });
    const tree = projectItems.items[0];
    assert.deepEqual(
      tree?.kind === 'snapshot' ? tree.threads.map((value) => value.id) : [],
      [child.id],
    );
    assert.deepEqual(terminalItems.items[0], {
      kind: 'snapshot',
      projectId: created.id,
      terminals: [],
    });

    const accepted = await harness.threads.prompt({
      id: child.id,
      prompt: 'Hello',
    });
    assert.equal(accepted.status, 'accepted');
    await harness.threadState(child.id, 'ready');
    await threadItems.until(() =>
      threadItems.items.some(
        (item) =>
          item.kind === 'event' && item.event.type === 'prompt.finished',
      ),
    );
    const sequences = threadItems.items.flatMap((item) =>
      item.kind === 'event' ? [item.event.sequence] : [],
    );
    assert.deepEqual(
      sequences,
      sequences.map((_value, index) => index + 1),
    );
    assert.ok(
      projectItems.items.some(
        (item) => item.kind === 'thread-updated' && item.thread.id === child.id,
      ),
    );
    for (const watch of watches) watch.dispose();
  } finally {
    await harness.dispose();
  }
});

void test('the runtime contracts refuse a watch whose input is not an ID', () => {
  const harness = createHarness();
  try {
    assert.throws(
      () =>
        harness.threads.watchThread(
          { threadId: 'bad', afterSequence: 0 },
          () => undefined,
        ),
      { code: 'invalid_input' },
    );
    assert.throws(
      () =>
        harness.threads.watchThread(
          { threadId, afterSequence: -1 },
          () => undefined,
        ),
      { code: 'invalid_input' },
    );
    assert.throws(
      () => harness.runtime.watchProject({ projectId: 'bad' }, () => undefined),
      { code: 'invalid_input' },
    );
  } finally {
    void harness.dispose();
  }
});
