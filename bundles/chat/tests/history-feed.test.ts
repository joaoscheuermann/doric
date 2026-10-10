// The conversation's feed of `history.snapshots/v1` (D9-19) and the store
// around it: a Thread opens from its cached snapshot, every update the
// conversation receives reaches the cache (events at the store's flush, other
// updates at once, failures never), and a failing cache changes nothing.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type { HistorySnapshots, HistoryWrite } from 'history/contracts';

import { createHistoryFeed } from '../src/client/api/history.js';
import type { ThreadWatch } from '../src/client/api/thread-watch.js';
import { createThreadsApi } from '../src/client/api/threads-api.js';
import type {
  Thread,
  ThreadEvent,
  ThreadUpdate,
} from '../src/client/domain/workspace.js';
import { createThreadChatsStore } from '../src/client/stores/thread-chats.js';

const THREAD = '11111111-1111-4111-8111-111111111111';

const thread: Thread = {
  id: THREAD,
  projectId: 'project-id',
  name: 'Thread',
  state: 'ready',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const event = (sequence: number): ThreadEvent => ({
  projectId: 'project-id',
  threadId: THREAD,
  promptId: 'prompt-id',
  sequence,
  type: 'agent.text',
  event: { text: `${sequence}` },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const fakeCache = (read: HistorySnapshots['read']) => {
  const writes: HistoryWrite[] = [];
  const cache: HistorySnapshots = {
    read,
    write: async (input) => {
      writes.push(input);
    },
  };
  return { cache, writes };
};

const fakeWatch = () => {
  const opened: {
    afterSequence: number;
    listener: (u: ThreadUpdate) => void;
  }[] = [];
  const watch: ThreadWatch = {
    watch: (_threadId, afterSequence, listener) => {
      opened.push({ afterSequence, listener });
      return () => undefined;
    },
  };
  return { watch, opened };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const storeOver = (cache: HistorySnapshots | undefined) => {
  const watch = fakeWatch();
  const history = () => cache;
  const store = createThreadChatsStore({
    watch: watch.watch,
    threads: createThreadsApi({
      threads: () => {
        throw new Error('no host in this test');
      },
      history,
    }),
    history: createHistoryFeed(history),
  });
  return { store, watch };
};

describe('history feed', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  test('a Thread opens from its cached snapshot and watches from where it ends', async () => {
    const { cache } = fakeCache(async () => ({
      thread: { ...thread, name: 'Cached' },
      lastSequence: 2,
      events: [event(1), event(2)],
    }));
    const { store, watch } = storeOver(cache);

    store.getState().open(thread);
    await settle();

    const chat = store.getState().chats.chats.get(THREAD);
    assert.equal(chat?.thread.name, 'Cached');
    assert.deepEqual(
      chat?.projection.events.map((entry) => entry.sequence),
      [1, 2],
    );
    assert.equal(watch.opened[0]?.afterSequence, 2);
  });

  test('a failed cache read opens the whole log, as with no snapshot', async () => {
    const { cache } = fakeCache(async () => {
      throw new Error('disk');
    });
    const { store, watch } = storeOver(cache);

    store.getState().open(thread);
    await settle();

    assert.ok(store.getState().chats.chats.has(THREAD));
    assert.equal(watch.opened[0]?.afterSequence, 0);
  });

  test('every update reaches the cache: events at the flush, the rest at once, errors never', async () => {
    const { cache, writes } = fakeCache(async () => null);
    const { store, watch } = storeOver(cache);
    store.getState().open(thread);
    await settle();
    const { listener } = watch.opened[0] ?? assert.fail('no watch');

    listener({
      kind: 'snapshot',
      snapshot: {
        threadId: THREAD,
        projectId: 'project-id',
        project: null,
        thread,
        events: [event(1)],
      },
    });
    listener({ kind: 'error', threadId: THREAD, message: 'stream failed' });
    listener({ kind: 'event', event: event(2) });
    listener({ kind: 'event', event: event(3) });
    listener({ kind: 'updated', thread: { ...thread, state: 'running' } });
    assert.deepEqual(
      writes.map(({ updates }) => updates.map((update) => update.kind)),
      [['snapshot'], ['updated']],
    );

    mock.timers.tick(100);

    assert.deepEqual(writes.at(-1), {
      threadId: THREAD,
      updates: [
        { kind: 'event', event: event(2) },
        { kind: 'event', event: event(3) },
      ],
    });
    assert.deepEqual(writes[0]?.updates[0], {
      kind: 'snapshot',
      thread,
      events: [event(1)],
    });
  });

  test('events still held when the chat part closes reach the cache', async () => {
    const { cache, writes } = fakeCache(async () => null);
    const { store, watch } = storeOver(cache);
    store.getState().open(thread);
    await settle();
    const { listener } = watch.opened[0] ?? assert.fail('no watch');
    listener({ kind: 'event', event: event(1) });
    mock.timers.tick(100);
    listener({ kind: 'event', event: event(2) });

    store.getState().closeAll();

    assert.deepEqual(
      writes.map(({ updates }) =>
        updates.map((update) =>
          update.kind === 'event' ? update.event.sequence : update.kind,
        ),
      ),
      [[1], [2]],
    );
    assert.equal(store.getState().chats.chats.size, 0);
  });

  test('a failing cache write and an absent cache change nothing the reader sees', async () => {
    const failing: HistorySnapshots = {
      read: async () => null,
      write: async () => {
        throw new Error('disk');
      },
    };
    for (const cache of [failing, undefined]) {
      const { store, watch } = storeOver(cache);
      store.getState().open(thread);
      await settle();
      const { listener } = watch.opened[0] ?? assert.fail('no watch');
      listener({ kind: 'updated', thread: { ...thread, name: 'Renamed' } });
      await settle();

      assert.equal(
        store.getState().chats.chats.get(THREAD)?.thread.name,
        'Renamed',
      );
    }
  });
});
