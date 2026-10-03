import assert from 'node:assert/strict';
import test from 'node:test';

import type { Host, ThreadControl } from 'host';
import { createToolStorage, type ToolCall, ToolErrorObject } from 'tool';

import events from '../tools/thread-events.js';
import get from '../tools/thread-get.js';
import interrupt from '../tools/thread-interrupt.js';
import list from '../tools/thread-list.js';
import send from '../tools/thread-send.js';
import spawn from '../tools/thread-spawn.js';
import terminate from '../tools/thread-terminate.js';

const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';

/** Thread tools never reach the workspace; the facade only has to carry one. */
const host = (control: ThreadControl): Host => ({
  threads: control,
  workspace: {
    cwd: () => '/workspace',
    setCwd: () => {
      throw new Error('Thread tests never move the working directory');
    },
  },
});
const tools = [spawn, list, get, events, send, interrupt, terminate] as const;

test('exposes thread tools in the established model-visible order', () => {
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

test('preserves thread control arguments, defaults, and serialized results', async () => {
  const control: ThreadControl = {
    spawn: async (prompt) => {
      assert.equal(prompt, ' task ');
      return { threadId, promptId };
    },
    list: async (limit, cursor) => {
      assert.equal(limit, 50);
      assert.equal(cursor, undefined);
      return { items: [] };
    },
    get: async (id) => {
      assert.equal(id, threadId);
      return { thread: { id } as never };
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
    tools.map((tool) => tool({} as never, host(control))),
  );
  const execute = (name: string, payload: ToolCall['payload']) =>
    storage.execute({ id: 'call', name, payload });

  assert.equal(
    await execute('thread-spawn', { prompt: ' task ' }),
    JSON.stringify({ threadId, promptId }),
  );
  assert.equal(await execute('thread-list', {}), JSON.stringify({ items: [] }));
  assert.equal(
    await execute('thread-get', { threadId }),
    JSON.stringify({ thread: { id: threadId } }),
  );
  assert.equal(
    await execute('thread-events', { threadId }),
    JSON.stringify({ events: [] }),
  );
  assert.equal(
    await execute('thread-send', { threadId, prompt: ' follow-up ' }),
    JSON.stringify({ promptId }),
  );
  assert.equal(
    await execute('thread-interrupt', { threadId, promptId }),
    'interrupted',
  );
  assert.equal(
    await execute('thread-terminate', { threadId }),
    JSON.stringify({ id: threadId, state: 'cancelled' }),
  );
});

test('rejects invalid thread control inputs at the tool boundary', async () => {
  const storage = createToolStorage(
    tools.map((tool) => tool({} as never, host({} as never))),
  );
  for (const [name, payload] of [
    ['thread-spawn', { prompt: '   ' }],
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
