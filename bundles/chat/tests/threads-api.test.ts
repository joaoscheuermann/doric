// The chat's host adapter (R-ERR): every failure shows the text the semantic
// preload showed. The main-process guards come first, then the REST route's
// input checks, then each host outcome maps to the REST route's message.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import { type RuntimeThreads, storageMessage } from 'runtime/contracts';

import {
  createThreadsApi,
  internalMessage,
  invalidResponseMessage,
  unavailableMessage,
} from '../src/client/api/threads-api.js';

const ID = '11111111-1111-4111-8111-111111111111';
const PROMPT = '22222222-2222-4222-8222-222222222222';

const record = {
  id: ID,
  projectId: 'project',
  name: 'Thread',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const apiOver = (host: Partial<RuntimeThreads>) => {
  const calls: string[] = [];
  const threads = new Proxy(host, {
    get: (target, name: string) => {
      const member = target[name as keyof RuntimeThreads];
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        calls.push(name);
        return (member as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as RuntimeThreads;
  return {
    api: createThreadsApi({ threads: () => threads, history: () => undefined }),
    calls,
  };
};

const rejectsWith = async (promise: Promise<unknown>, message: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    return true;
  });

describe('threads adapter', () => {
  test('guards run before the host and keep their messages', async () => {
    const { api, calls } = apiOver({});
    await rejectsWith(api.prompt('', 'hi'), 'The item identifier is invalid.');
    await rejectsWith(
      api.prompt('not-a-uuid', '   '),
      'Enter a prompt before continuing.',
    );
    await rejectsWith(
      api.prompt('not-a-uuid', 'hi'),
      'The thread ID is invalid.',
    );
    await rejectsWith(
      api.editQueued(ID, PROMPT, 'text', -1),
      'Invalid prompt revision.',
    );
    await rejectsWith(api.resume(ID, 'not-a-uuid'), 'A promptId is required.');
    await rejectsWith(api.interrupt(ID, 'nope'), 'A promptId is required.');
    await rejectsWith(api.queuedPrompt(ID, 'nope'), 'A promptId is required.');
    await rejectsWith(api.removeQueued(ID, 'nope'), 'A promptId is required.');
    await rejectsWith(
      api.rewind(ID, 'nope', 'again'),
      'A prompt ID and a non-empty prompt are required.',
    );
    await rejectsWith(
      api.editQueued(ID, 'nope', 'text', 1),
      'A prompt ID, non-empty text and its revision are required.',
    );
    assert.deepEqual(calls, []);
  });

  test('a sent prompt answers its receipt; a missing or inactive Thread its REST message', async () => {
    let status: 'accepted' | 'missing' | 'inactive' = 'accepted';
    const { api } = apiOver({
      prompt: async () =>
        status === 'accepted' ? { status, promptId: PROMPT } : { status },
    });
    assert.deepEqual(await api.prompt(ID, 'hello'), { promptId: PROMPT });
    status = 'missing';
    await rejectsWith(api.prompt(ID, 'hello'), 'The thread was not found.');
    status = 'inactive';
    await rejectsWith(
      api.prompt(ID, 'hello'),
      'The thread cannot perform this operation.',
    );
  });

  test('resume, rewind and the queue resume map every outcome', async () => {
    const outcomes = {
      resume: [
        ['unknown_prompt', 'The prompt was not found in this Thread.'],
        ['busy', 'The thread cannot perform this operation.'],
        ['storage_low', storageMessage],
      ],
      rewind: [
        ['unknown_prompt', 'The prompt was not found in this Thread.'],
        [
          'busy',
          'The Thread is running or has queued input and cannot be rewound.',
        ],
        ['inactive', 'The thread cannot perform this operation.'],
      ],
    } as const;
    for (const [status, message] of outcomes.resume) {
      const { api } = apiOver({ resume: async () => ({ status }) });
      await rejectsWith(api.resume(ID, PROMPT), message);
    }
    for (const [status, message] of outcomes.rewind) {
      const { api } = apiOver({ rewind: async () => ({ status }) });
      await rejectsWith(api.rewind(ID, PROMPT, 'again'), message);
    }
    const resumed = apiOver({
      resume: async () => ({ status: 'resumed', thread: record as never }),
      resumeQueue: async () => ({ status: 'storage_low' }),
    });
    assert.equal((await resumed.api.resume(ID, PROMPT)).id, ID);
    await rejectsWith(resumed.api.resumeQueue(ID), storageMessage);
  });

  test('queue edits keep their three sentences', async () => {
    const cases = [
      [
        'conflict',
        'This prompt was edited elsewhere. Your changes have not been saved.',
      ],
      [
        'not_editable',
        'Only your prompts that have not started can be edited. Your changes have not been saved.',
      ],
      [
        'unknown_prompt',
        'This prompt is no longer available for editing. Your changes have not been saved.',
      ],
      [
        'inactive',
        'This prompt is no longer available for editing. Your changes have not been saved.',
      ],
    ] as const;
    for (const [status, message] of cases) {
      const { api } = apiOver({ editQueued: async () => ({ status }) });
      await rejectsWith(api.editQueued(ID, PROMPT, 'text', 2), message);
    }
    const { api } = apiOver({ queuedPrompt: async () => undefined });
    await rejectsWith(
      api.queuedPrompt(ID, PROMPT),
      'This prompt is no longer queued.',
    );
  });

  test('interrupt and queue removal answer nothing on success and map refusals', async () => {
    const { api } = apiOver({
      pause: async () => 'interrupted',
      removeQueued: async () => 'removed',
    });
    assert.equal(await api.interrupt(ID, PROMPT), undefined);
    assert.equal(await api.removeQueued(ID, PROMPT), undefined);
    const refused = apiOver({
      pause: async () => 'not_running',
      removeQueued: async () => 'missing',
    });
    await rejectsWith(
      refused.api.interrupt(ID, PROMPT),
      'The thread cannot perform this operation.',
    );
    await rejectsWith(
      refused.api.removeQueued(ID, PROMPT),
      'The thread was not found.',
    );
  });

  test('a deleted Thread reads as undefined; a malformed record is an invalid response', async () => {
    const missing = apiOver({ thread: async () => undefined });
    assert.equal(await missing.api.get(ID), undefined);
    const malformed = apiOver({
      thread: async () => ({ ...record, cwd: 3 }) as never,
    });
    await rejectsWith(malformed.api.get(ID), invalidResponseMessage);
  });

  test('host failures read as the REST client read them', async () => {
    const failing = (error: unknown) =>
      apiOver({
        queue: async () => {
          throw error;
        },
      }).api;
    await rejectsWith(
      failing(new ContractError('disconnected', 'bridge')).queue(ID),
      unavailableMessage,
    );
    await rejectsWith(
      failing(new ContractError('unavailable', 'none')).queue(ID),
      unavailableMessage,
    );
    await rejectsWith(
      failing(new ContractError('invalid_output', 'shape')).queue(ID),
      invalidResponseMessage,
    );
    await rejectsWith(failing(new Error('boom')).queue(ID), internalMessage);
  });

  test('without a history cache the snapshot is null', async () => {
    const { api } = apiOver({});
    assert.equal(await api.history(ID), null);
  });
});
