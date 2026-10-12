// R-9.6: a held conversation reports every live event of its Thread as it
// arrives (before the stream's 100 ms flush draws it) and every `updated`
// record, never a history snapshot, through `onThreadUpdateHook`.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type { ThreadWatch } from '../src/client/api/thread-watch.js';
import type { Thread, ThreadUpdate } from '../src/client/domain/workspace.js';
import {
  createThreadChatsStore,
  type ObserveUpdate,
} from '../src/client/stores/thread-chats.js';

const thread = (id: string, name = id): Thread => ({
  id,
  projectId: 'project-a',
  name,
  state: 'ready',
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});

const event = (sequence: number) => ({
  kind: 'event' as const,
  event: {
    projectId: 'project-a',
    threadId: 'a',
    promptId: 'prompt',
    sequence,
    createdAt: '',
    type: 'tool.finished',
    event: {
      type: 'tool.finished',
      call: { id: `call-${sequence}`, name: 'edit', arguments: '{}' },
      record: { output: 'ok' },
    },
  },
});

const setup = async (observe?: ObserveUpdate) => {
  let listener: ((update: ThreadUpdate) => void) | undefined;
  const watch: ThreadWatch = {
    watch: (_id, _after, next) => {
      listener = next;
      return () => undefined;
    },
  };
  const store = createThreadChatsStore({
    watch,
    threads: {
      history: async () => null,
      prompt: async () => ({ promptId: 'p' }),
      rewind: async () => ({ promptId: 'p' }),
      resume: async () => thread('a'),
    },
    history: { write: () => undefined },
    ...(observe === undefined ? {} : { observe }),
  });
  store.getState().open(thread('a', 'Fix the build'));
  await new Promise((resolve) => setImmediate(resolve));
  return {
    store,
    send: (update: ThreadUpdate) => listener?.(update),
  };
};

describe('onThreadUpdateHook', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => mock.timers.reset());

  test('a live event is reported when it arrives, before the flush draws it', async () => {
    const seen: Parameters<ObserveUpdate>[0][] = [];
    const { store, send } = await setup((input) => seen.push(input));

    send(event(1));
    send(event(2));

    assert.deepEqual(
      seen.map((input) => [
        input.projectId,
        input.threadId,
        input.threadName,
        input.update.kind,
        input.update.kind === 'event' ? input.update.event.sequence : -1,
      ]),
      [
        ['project-a', 'a', 'Fix the build', 'event', 1],
        ['project-a', 'a', 'Fix the build', 'event', 2],
      ],
    );
    // The conversation itself has not drawn the burst yet.
    const before = store.getState().chats;
    mock.timers.tick(100);
    assert.notEqual(store.getState().chats, before);
  });

  test('an updated record is reported with its own name; a snapshot is not', async () => {
    const seen: Parameters<ObserveUpdate>[0][] = [];
    const { send } = await setup((input) => seen.push(input));

    send({
      kind: 'snapshot',
      snapshot: {
        threadId: 'a',
        projectId: 'project-a',
        project: null,
        thread: thread('a', 'Fix the build'),
        events: [event(1).event],
      },
    });
    send({ kind: 'updated', thread: thread('a', 'Renamed') });

    assert.deepEqual(
      seen.map((input) => [input.threadName, input.update.kind]),
      [['Renamed', 'updated']],
    );
  });

  test('a failing observer never breaks the stream', async () => {
    const { store, send } = await setup(() => {
      throw new Error('observer failed');
    });

    send(event(1));
    mock.timers.tick(100);

    assert.ok(store.getState().chats.chats.has('a'));
  });
});
