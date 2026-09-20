import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolStorage, ToolErrorObject } from 'tool';

import {
  coordinationNames,
  createCoordinationTools,
} from '../src/lib/agents/direct/tools/index.js';
import type { ThreadCoordination } from '../src/lib/workspace/coordination.js';

const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';

test('exposes coordination tools in the established model-visible order', () => {
  const tools = createCoordinationTools({} as never, {} as never);
  const expected = [
    'spawn_thread',
    'list_threads',
    'get_thread',
    'send_to_thread',
    'interrupt_thread',
    'terminate_thread',
  ];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    expected,
  );
  assert.deepEqual(coordinationNames, expected);
});

test('preserves coordination arguments, defaults, and serialized results', async () => {
  const control: ThreadCoordination = {
    spawn: async (prompt) => {
      assert.equal(prompt, ' task ');
      return { threadId, promptId };
    },
    list: async (limit, cursor) => {
      assert.equal(limit, 50);
      assert.equal(cursor, undefined);
      return { items: [] };
    },
    get: async (id, sequence) => {
      assert.equal(id, threadId);
      assert.equal(sequence, 0);
      return { thread: { id } as never, events: [] };
    },
    send: async (id, prompt) => {
      assert.equal(id, threadId);
      assert.equal(prompt, ' follow-up ');
      return { promptId } as never;
    },
    interrupt: async (id, activePromptId) => {
      assert.equal(id, threadId);
      assert.equal(activePromptId, promptId);
      return 'interrupted';
    },
    terminate: async (id) => {
      assert.equal(id, threadId);
      return { id, state: 'cancelled' } as never;
    },
  };
  const storage = createToolStorage(
    createCoordinationTools(control, {} as never),
  );
  const execute = (name: string, payload: Record<string, string>) =>
    storage.execute({ id: 'call', name, payload });

  assert.equal(
    await execute('spawn_thread', { prompt: ' task ' }),
    JSON.stringify({ threadId, promptId }),
  );
  assert.equal(
    await execute('list_threads', {}),
    JSON.stringify({ items: [] }),
  );
  assert.equal(
    await execute('get_thread', { threadId }),
    JSON.stringify({ thread: { id: threadId }, events: [] }),
  );
  assert.equal(
    await execute('send_to_thread', { threadId, prompt: ' follow-up ' }),
    JSON.stringify({ promptId }),
  );
  assert.equal(
    await execute('interrupt_thread', { threadId, promptId }),
    'interrupted',
  );
  assert.equal(
    await execute('terminate_thread', { threadId }),
    JSON.stringify({ id: threadId, state: 'cancelled' }),
  );
});

test('rejects invalid coordination inputs at the tool boundary', async () => {
  const storage = createToolStorage(
    createCoordinationTools({} as never, {} as never),
  );
  for (const [name, payload] of [
    ['spawn_thread', { prompt: '   ' }],
    ['send_to_thread', { threadId, prompt: '' }],
    ['list_threads', { limit: 0 }],
    ['list_threads', { limit: 101 }],
    ['get_thread', { threadId, afterSequence: -1 }],
    ['interrupt_thread', { threadId, promptId: 'invalid' }],
    ['terminate_thread', { threadId, extra: true }],
  ] as const) {
    await assert.rejects(
      storage.execute({ id: 'call', name, payload }),
      (error: unknown) => {
        assert.ok(error instanceof ToolErrorObject);
        assert.equal(error.data.code, 'invalid_payload');
        return true;
      },
    );
  }
});
