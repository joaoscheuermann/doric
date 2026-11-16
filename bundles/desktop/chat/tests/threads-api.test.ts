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

/**
 * Rejects with the adapters' `ClientError` (§6.4): its `code`, its unchanged
 * `message`, and `cause` — the contract error itself, or none.
 */
const rejectsWithClientError = async (
  promise: Promise<unknown>,
  expected: {
    readonly code: string;
    readonly message: string;
    readonly cause: unknown;
  },
) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ClientError');
    assert.equal((error as Error & { code?: unknown }).code, expected.code);
    assert.equal(error.message, expected.message);
    assert.equal(error.cause, expected.cause);
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

  test('a steer answers whether the running prompt took it or it was queued', async () => {
    const sent: unknown[] = [];
    const { api } = apiOver({
      steer: async (input) => {
        sent.push(input);
        return { status: 'queued', promptId: PROMPT };
      },
    });
    assert.deepEqual(
      await api.steer(ID, 'Use the cache', {
        promptId: PROMPT,
        interrupt: true,
      }),
      { status: 'queued', promptId: PROMPT },
    );
    assert.deepEqual(sent, [
      { id: ID, prompt: 'Use the cache', promptId: PROMPT, interrupt: true },
    ]);
    for (const [status, message] of [
      ['missing', 'The thread was not found.'],
      ['inactive', 'The thread cannot perform this operation.'],
    ] as const) {
      const refused = apiOver({ steer: async () => ({ status }) });
      await rejectsWith(
        refused.api.steer(ID, 'late', { promptId: PROMPT }),
        message,
      );
    }
    await rejectsWith(
      apiOver({}).api.steer(ID, 'late', { promptId: 'not-a-uuid' }),
      'A promptId is required.',
    );
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

  test('T-20 a contract error keeps its code and itself as the cause; the message is unchanged', async () => {
    const failing = (error: unknown) =>
      apiOver({
        queue: async () => {
          throw error;
        },
      }).api;
    for (const [code, message] of [
      ['disconnected', unavailableMessage],
      ['unavailable', unavailableMessage],
      ['generation_lost', unavailableMessage],
      ['invalid_output', invalidResponseMessage],
      ['limit_exceeded', internalMessage],
    ] as const) {
      const contract = new ContractError(code, 'what the bridge said');
      await rejectsWithClientError(failing(contract).queue(ID), {
        code,
        message,
        cause: contract,
      });
    }
  });

  test('T-20 an internal contract error or a foreign throw gives code internal and no cause', async () => {
    const failing = (error: unknown) =>
      apiOver({
        queue: async () => {
          throw error;
        },
      }).api;
    await rejectsWithClientError(
      failing(new ContractError('internal', 'raw host text')).queue(ID),
      { code: 'internal', message: internalMessage, cause: undefined },
    );
    await rejectsWithClientError(failing(new Error('boom')).queue(ID), {
      code: 'internal',
      message: internalMessage,
      cause: undefined,
    });
  });

  test('T-20 a refused argument is invalid_input, an unreadable answer invalid_output, both without a cause', async () => {
    const { api, calls } = apiOver({});
    await rejectsWithClientError(api.prompt('not-a-uuid', 'hi'), {
      code: 'invalid_input',
      message: 'The thread ID is invalid.',
      cause: undefined,
    });
    await rejectsWithClientError(api.resume(ID, 'not-a-uuid'), {
      code: 'invalid_input',
      message: 'A promptId is required.',
      cause: undefined,
    });
    assert.deepEqual(calls, []);
    const malformed = apiOver({
      thread: async () => ({ ...record, cwd: 3 }) as never,
    });
    await rejectsWithClientError(malformed.api.get(ID), {
      code: 'invalid_output',
      message: invalidResponseMessage,
      cause: undefined,
    });
  });

  test('T-20 a missing target is not_found and a refused action conflict, without a cause', async () => {
    const missing = apiOver({ prompt: async () => ({ status: 'missing' }) });
    await rejectsWithClientError(missing.api.prompt(ID, 'hello'), {
      code: 'not_found',
      message: 'The thread was not found.',
      cause: undefined,
    });
    const unknown = apiOver({
      resume: async () => ({ status: 'unknown_prompt' }),
    });
    await rejectsWithClientError(unknown.api.resume(ID, PROMPT), {
      code: 'not_found',
      message: 'The prompt was not found in this Thread.',
      cause: undefined,
    });
    const inactive = apiOver({ prompt: async () => ({ status: 'inactive' }) });
    await rejectsWithClientError(inactive.api.prompt(ID, 'hello'), {
      code: 'conflict',
      message: 'The thread cannot perform this operation.',
      cause: undefined,
    });
    const notRunning = apiOver({ pause: async () => 'not_running' });
    await rejectsWithClientError(notRunning.api.interrupt(ID, PROMPT), {
      code: 'conflict',
      message: 'The thread cannot perform this operation.',
      cause: undefined,
    });
  });

  test('without a history cache the snapshot is null', async () => {
    const { api } = apiOver({});
    assert.equal(await api.history(ID), null);
  });
});
