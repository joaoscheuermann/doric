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
        rewind: async () => ({ promptId: 'p' }),
        resume: async () => thread('x', 'x'),
      },
      announce: () => undefined,
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
