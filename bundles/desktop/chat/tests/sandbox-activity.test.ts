// D9-10: a held conversation that sees a sandbox write tells the refresh
// coordinator once per changed Project, through onSandboxActivityHook.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type { ThreadWatch } from '../src/client/api/thread-watch.js';
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

  test('a write in a background conversation names its Project; a read-only tool names none', async () => {
    const listeners = new Map<string, (update: ThreadUpdate) => void>();
    const watch: ThreadWatch = {
      watch: (id, _after, listener) => {
        listeners.set(id, listener);
        return () => undefined;
      },
    };
    const store = createThreadChatsStore({
      watch,
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

    const projects: string[] = [];
    const stop = watchSandboxActivity(store, {
      onSandboxActivityHook: {
        execute: async ({ projectId }) => {
          projects.push(projectId);
        },
      },
    });
    const tool = (id: string, sequence: number, name: string) => ({
      kind: 'event' as const,
      event: {
        projectId: id === 'a' ? 'project-a' : 'project-b',
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
    listeners.get('a')?.(tool('a', 1, 'edit'));
    mock.timers.tick(100);
    listeners.get('b')?.(tool('b', 1, 'tree'));
    mock.timers.tick(100);
    stop();
    listeners.get('a')?.(tool('a', 2, 'edit'));
    mock.timers.tick(100);

    assert.deepEqual(projects, ['project-a']);
  });
});

// Bundle isolation 5(c), T5.5: with both handles, `chat.hooks/v1` hears every
// cause and `chat.hooks/v2` only the lifecycle ones.
describe('sandbox activity on chat.hooks/v1 and chat.hooks/v2', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => mock.timers.reset());

  /** A store holding Thread `a` of `project-a`, watched with both handles. */
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
    await new Promise((resolve) => setImmediate(resolve));

    const heard = { v1: [] as string[], v2: [] as string[] };
    const stop = watchSandboxActivity(
      store,
      {
        onSandboxActivityHook: {
          execute: async ({ projectId }) => {
            heard.v1.push(projectId);
          },
        },
      },
      {
        onSandboxActivityHook: {
          execute: async ({ projectId }) => {
            heard.v2.push(projectId);
          },
        },
      },
    );
    const send = (update: ThreadUpdate) => {
      listeners.get('a')?.(update);
      mock.timers.tick(100);
    };
    const updated = (changes: Partial<Thread>) =>
      send({
        kind: 'updated',
        thread: { ...thread('a', 'project-a'), ...changes },
      });
    return { heard, stop, send, updated };
  };

  test('a finished edit is heard on v1 and not on v2', async () => {
    const { heard, send } = await held();

    send({
      kind: 'event',
      event: {
        projectId: 'project-a',
        threadId: 'a',
        promptId: 'prompt',
        sequence: 1,
        createdAt: '',
        type: 'tool.finished',
        event: {
          type: 'tool.finished',
          call: { id: 'call-1', name: 'edit', arguments: '{}' },
          record: { output: 'ok' },
        },
      },
    });

    assert.deepEqual(heard, { v1: ['project-a'], v2: [] });
  });

  test("a held Thread's changed cwd is heard once on each", async () => {
    const { heard, updated } = await held();

    updated({ cwd: '/workspace/other' });

    assert.deepEqual(heard, { v1: ['project-a'], v2: ['project-a'] });
  });

  test('a run that ends is heard on each; a run that starts on neither', async () => {
    const { heard, updated } = await held();

    updated({ state: 'running' });
    assert.deepEqual(heard, { v1: [], v2: [] });

    updated({ state: 'ready' });
    assert.deepEqual(heard, { v1: ['project-a'], v2: ['project-a'] });
  });

  test('after stop neither handle hears anything', async () => {
    const { heard, stop, updated } = await held();

    stop();
    updated({ cwd: '/workspace/other' });

    assert.deepEqual(heard, { v1: [], v2: [] });
  });
});
