import assert from 'node:assert/strict';
import test from 'node:test';

import type { ThreadControl, ThreadView } from 'runtime/contracts';
import { createToolStorage, type ToolCall, ToolErrorObject } from 'tool';

import { activatedTools } from './support/services.js';

const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';

/** A child record as the host stores it, with keys beyond ThreadView. */
const view: ThreadView & { readonly cwd: string } = {
  id: threadId,
  projectId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1600',
  parentThreadId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603',
  name: 'Child',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

void test('registers thread tools in the established model-visible order', async () => {
  const tools = await activatedTools({} as never);
  const expected = [
    'thread-spawn',
    'thread-list',
    'thread-get',
    'thread-events',
    'thread-send',
    'thread-interrupt',
    'thread-terminate',
  ];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    expected,
  );
});

void test('preserves thread control arguments, defaults, and serialized results', async () => {
  const control: ThreadControl = {
    spawn: async (prompt, title) => {
      assert.equal(prompt, ' task ');
      assert.equal(title, ' Task ');
      return { threadId, promptId };
    },
    list: async (limit, cursor) => {
      assert.equal(limit, 50);
      assert.equal(cursor, undefined);
      return { items: [] };
    },
    get: async (id) => {
      assert.equal(id, threadId);
      return { thread: { ...view, id } };
    },
    events: async (id, afterSequence, limit) => {
      assert.equal(id, threadId);
      assert.equal(afterSequence, 0);
      assert.equal(limit, 20);
      return { events: [] };
    },
    send: async (id, prompt) => {
      assert.equal(id, threadId);
      assert.equal(prompt, ' follow-up ');
      return { status: 'accepted', promptId };
    },
    interrupt: async (id, activePromptId) => {
      assert.equal(id, threadId);
      assert.equal(activePromptId, promptId);
      return 'interrupted';
    },
    terminate: async (id) => {
      assert.equal(id, threadId);
      return { ...view, id, state: 'cancelled' };
    },
  };
  const storage = createToolStorage(await activatedTools(control));
  const execute = (name: string, payload: ToolCall['payload']) =>
    storage.execute({ id: 'call', name, payload });

  assert.equal(
    await execute('thread-spawn', { prompt: ' task ', title: ' Task ' }),
    JSON.stringify({ threadId, promptId }),
  );
  assert.equal(await execute('thread-list', {}), JSON.stringify({ items: [] }));
  assert.equal(
    await execute('thread-get', { threadId }),
    JSON.stringify({ thread: view }),
  );
  assert.equal(
    await execute('thread-events', { threadId }),
    JSON.stringify({ events: [] }),
  );
  assert.equal(
    await execute('thread-send', { threadId, prompt: ' follow-up ' }),
    JSON.stringify({ status: 'accepted', promptId }),
  );
  assert.equal(
    await execute('thread-interrupt', { threadId, promptId }),
    'interrupted',
  );
  assert.equal(
    await execute('thread-terminate', { threadId }),
    JSON.stringify({ ...view, state: 'cancelled' }),
  );
});

void test('rejects invalid thread control inputs at the tool boundary', async () => {
  const storage = createToolStorage(await activatedTools({} as never));
  for (const [name, payload] of [
    ['thread-spawn', { prompt: '   ' }],
    ['thread-spawn', { prompt: 'task', title: '  ' }],
    ['thread-send', { threadId, prompt: '' }],
    ['thread-list', { limit: 0 }],
    ['thread-list', { limit: 101 }],
    ['thread-get', { threadId: 'invalid' }],
    ['thread-events', { threadId, afterSequence: -1 }],
    ['thread-events', { threadId, limit: 0 }],
    ['thread-events', { threadId, limit: 51 }],
    ['thread-interrupt', { threadId, promptId: 'invalid' }],
    ['thread-terminate', { threadId, extra: true }],
  ] as const) {
    const call: ToolCall = { id: 'call', name, payload };

    await assert.rejects(storage.execute(call), (error: unknown) => {
      assert.ok(error instanceof ToolErrorObject);
      assert.equal(error.data.code, 'invalid_payload');
      return true;
    });
  }
});
