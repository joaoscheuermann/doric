// D9-10, bundle isolation 5(c): a held conversation whose Thread the chat
// starts to hold, whose working directory changes or whose run ends tells the
// refresh coordinator once per changed Project, through `chat.hooks/v2`
// `onSandboxActivityHook`; a finished tool call tells it nothing (T5.5).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type { Thread, ThreadUpdate } from '../src/client/domain/workspace.js';
import { watchSandboxActivity } from '../src/client/services/sandbox-activity.js';
import { createThreadChatsStore } from '../src/client/stores/thread-chats.js';

const thread = (id: string, projectId: string): Thread => ({
  id,
  projectId,
  name: id,
  state: 'ready',
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});

describe('sandbox activity', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => mock.timers.reset());

  /** A store holding Threads `a` of `project-a` and `b` of `project-b`, watched. */
  const held = async () => {
    const listeners = new Map<string, (update: ThreadUpdate) => void>();
    const store = createThreadChatsStore({
      watch: {
        watch: (id, _after, listener) => {
          listeners.set(id, listener);
          return () => undefined;
        },
      },
      threads: {
        history: async () => null,
        prompt: async () => ({ promptId: 'p' }),
        steer: async () => ({ promptId: 'p', status: 'steered' as const }),
        rewind: async () => ({ promptId: 'p' }),
        resume: async () => thread('x', 'x'),
        retry: async () => ({ promptId: 'p' }),
      },
      history: { write: () => undefined },
    });
    store.getState().open(thread('a', 'project-a'));
    store.getState().open(thread('b', 'project-b'));
    await new Promise((resolve) => setImmediate(resolve));

    const heard: string[] = [];
    const stop = watchSandboxActivity(store, {
      onSandboxActivityHook: {
        execute: async ({ projectId }) => {
          heard.push(projectId);
        },
      },
    });
    const send = (id: 'a' | 'b', update: ThreadUpdate) => {
      listeners.get(id)?.(update);
      mock.timers.tick(100);
    };
    const updated = (id: 'a' | 'b', changes: Partial<Thread>) =>
      send(id, {
        kind: 'updated',
        thread: { ...thread(id, `project-${id}`), ...changes },
      });
    const finished = (id: 'a' | 'b', sequence: number, name: string) =>
      send(id, {
        kind: 'event',
        event: {
          projectId: `project-${id}`,
          threadId: id,
          promptId: 'prompt',
          sequence,
          createdAt: '',
          type: 'tool.finished',
          event: {
            type: 'tool.finished',
            call: { id: `call-${sequence}`, name, arguments: '{}' },
            record: { output: 'ok' },
          },
        },
      });
    return { heard, stop, updated, finished };
  };

  test('a finished edit in a background conversation names no Project; a changed cwd names it', async () => {
    const { heard, updated, finished } = await held();

    finished('a', 1, 'edit');
    finished('b', 1, 'tree');
    updated('b', { cwd: '/workspace/other' });

    assert.deepEqual(heard, ['project-b']);
  });

  test('a run that ends names its Project; a run that starts names none', async () => {
    const { heard, updated } = await held();

    updated('a', { state: 'running' });
    assert.deepEqual(heard, []);

    updated('a', { state: 'ready' });
    assert.deepEqual(heard, ['project-a']);
  });

  test('after stop nothing is heard', async () => {
    const { heard, stop, updated } = await held();

    stop();
    updated('a', { cwd: '/workspace/other' });

    assert.deepEqual(heard, []);
  });
});
