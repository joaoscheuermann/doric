// Bundle isolation 5(c), changes 1–5: the surfaces execute `chat.hooks/v1`
// and `chat.hooks/v2` through one handle. Each observe reaches both, one
// failing never silences the other, and the transform chains v1 into v2.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HookHandle } from 'bundle/contracts';

import {
  bothChatHooks,
  type ChatHooks,
} from '../src/client/services/chat-hooks.js';
import type {
  ChatHooksV1,
  RenderBlock,
  ThreadUpdateInput,
} from '../src/contracts/index.js';

type Behavior = (input: unknown) => Promise<unknown>;

/** A fake owner handle: records each execute and answers with `behavior`. */
const handle = (
  calls: string[],
  name: string,
  behavior: Partial<Record<string, Behavior>> = {},
) => {
  const hook = (id: string) => ({
    execute: (input: unknown) => {
      calls.push(`${name}.${id} ${JSON.stringify(input)}`);
      const answer = behavior[id];
      return answer === undefined
        ? Promise.resolve(id === 'onBeforeRenderBlockHook' ? input : undefined)
        : answer(input);
    },
  });
  return {
    onMountHook: hook('onMountHook'),
    onUnmountHook: hook('onUnmountHook'),
    onBeforeRenderBlockHook: hook('onBeforeRenderBlockHook'),
    onSandboxActivityHook: hook('onSandboxActivityHook'),
    onThreadUpdateHook: hook('onThreadUpdateHook'),
  };
};

const v1 = (
  calls: string[],
  behavior?: Partial<Record<string, Behavior>>,
): HookHandle<typeof ChatHooksV1> => handle(calls, 'v1', behavior) as never;

const v2 = (
  calls: string[],
  behavior?: Partial<Record<string, Behavior>>,
): ChatHooks => handle(calls, 'v2', behavior) as never;

const ref = { projectId: 'project-a', threadId: 'thread-a' };

const block: RenderBlock = {
  id: 'note:1',
  type: 'probe.note',
  promptId: 'prompt',
  sequence: 1,
  data: { text: 'remember' },
  actions: [],
};

test('an observe hook reaches both handles with the same input', async () => {
  const calls: string[] = [];
  const hooks = bothChatHooks(v1(calls), v2(calls));
  const update: ThreadUpdateInput = {
    projectId: 'project-a',
    threadId: 'thread-a',
    threadName: 'Fix the parser',
    update: {
      kind: 'updated',
      thread: {
        id: 'thread-a',
        projectId: 'project-a',
        name: 'Fix the parser',
        state: 'ready',
        cwd: '/workspace',
        createdAt: '',
        updatedAt: '',
      },
    } as never,
  };

  await hooks.onMountHook.execute(ref);
  await hooks.onUnmountHook.execute(ref);
  await hooks.onThreadUpdateHook.execute(update);

  const input = JSON.stringify(ref);
  assert.deepEqual(
    [...calls].sort(),
    [
      `v1.onMountHook ${input}`,
      `v2.onMountHook ${input}`,
      `v1.onUnmountHook ${input}`,
      `v2.onUnmountHook ${input}`,
      `v1.onThreadUpdateHook ${JSON.stringify(update)}`,
      `v2.onThreadUpdateHook ${JSON.stringify(update)}`,
    ].sort(),
  );
});

test('a v1 observe that throws still reaches v2, and the execute rejects', async () => {
  const calls: string[] = [];
  const hooks = bothChatHooks(
    v1(calls, {
      onMountHook: () => {
        throw new Error('v1 failed');
      },
    }),
    v2(calls),
  );

  await assert.rejects(hooks.onMountHook.execute(ref));

  assert.ok(
    calls.includes(`v2.onMountHook ${JSON.stringify(ref)}`),
    calls.join('\n'),
  );
});

test('a v1 observe that rejects still reaches v2, and the execute rejects', async () => {
  const calls: string[] = [];
  const hooks = bothChatHooks(
    v1(calls, { onUnmountHook: () => Promise.reject(new Error('v1 failed')) }),
    v2(calls),
  );

  await assert.rejects(hooks.onUnmountHook.execute(ref));

  assert.ok(
    calls.includes(`v2.onUnmountHook ${JSON.stringify(ref)}`),
    calls.join('\n'),
  );
});

test('a v2 observe that fails still reaches v1, and the execute rejects', async () => {
  const calls: string[] = [];
  const hooks = bothChatHooks(
    v1(calls),
    v2(calls, { onMountHook: () => Promise.reject(new Error('v2 failed')) }),
  );

  await assert.rejects(hooks.onMountHook.execute(ref));

  assert.ok(
    calls.includes(`v1.onMountHook ${JSON.stringify(ref)}`),
    calls.join('\n'),
  );
});

test("the transform passes the block through v1, then v1's output through v2, and resolves v2's output", async () => {
  const calls: string[] = [];
  const fromV1 = { ...block, actions: [{ id: 'open', label: 'Open note' }] };
  const fromV2 = {
    ...fromV1,
    actions: [...fromV1.actions, { id: 'pin', label: 'Pin note' }],
  };
  const hooks = bothChatHooks(
    v1(calls, { onBeforeRenderBlockHook: async () => fromV1 }),
    v2(calls, { onBeforeRenderBlockHook: async () => fromV2 }),
  );

  const drawn = await hooks.onBeforeRenderBlockHook.execute(block);

  assert.deepEqual(drawn, fromV2);
  assert.deepEqual(calls, [
    `v1.onBeforeRenderBlockHook ${JSON.stringify(block)}`,
    `v2.onBeforeRenderBlockHook ${JSON.stringify(fromV1)}`,
  ]);
});
