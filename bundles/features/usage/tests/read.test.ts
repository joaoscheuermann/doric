import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import type { ThreadUsage } from 'runtime/contracts';

import { readThreadUsage, usageQueryKey } from '../src/client/domain/read.js';
import type { Usage } from '../src/contracts/index.js';

const empty: ThreadUsage = {
  total: {
    calls: 0,
    unpricedCalls: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  },
  threads: [],
};

const source = (thread: Usage['thread']): Usage => ({ thread });

describe('the footer usage read', () => {
  test('keeps the renderer query key', () => {
    assert.deepEqual(usageQueryKey('thread-1'), [
      'thread',
      'thread-1',
      'usage',
    ]);
  });

  test('answers the host usage with a deadline on the call', async () => {
    let options: unknown;
    const value = await readThreadUsage(
      source(async (_id, call) => {
        options = call;
        return empty;
      }),
      'thread-1',
    );

    assert.deepEqual(value, empty);
    const deadline = (options as { deadline: number }).deadline;
    assert.ok(deadline > Date.now() && deadline <= Date.now() + 10_000);
  });

  test('fails an unknown Thread as the REST 404 did', async () => {
    await assert.rejects(
      readThreadUsage(
        source(async () => undefined),
        'missing',
      ),
      { message: 'The thread was not found.' },
    );
  });

  test('a lost bridge is the backend being unavailable', async () => {
    await assert.rejects(
      readThreadUsage(
        source(async () => {
          throw new ContractError('disconnected', 'gone');
        }),
        'thread-1',
      ),
      { message: 'Doric backend is unavailable.' },
    );
  });

  test('refuses an invalid identifier before calling', async () => {
    let called = false;
    await assert.rejects(
      readThreadUsage(
        source(async () => {
          called = true;
          return empty;
        }),
        '',
      ),
      { message: 'The item identifier is invalid.' },
    );
    assert.equal(called, false);
  });
});
