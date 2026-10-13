import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import type { ThreadUsage } from 'runtime/contracts';

import {
  compactResultMessage,
  compactThread,
  readCompactionTarget,
  readThreadUsage,
  usageQueryKey,
  writeCompactionTarget,
} from '../src/client/domain/read.js';
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

/** The members this test does not exercise: they refuse if ever called. */
const refused = (..._args: never[]): Promise<never> =>
  Promise.reject(new Error('Not this test\u2019s call.'));

const source = (thread: Usage['thread']): Usage => ({
  thread,
  compact: refused as Usage['compact'],
  compactionTarget: refused as Usage['compactionTarget'],
  setCompactionTarget: refused as Usage['setCompactionTarget'],
});

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

describe('the compaction calls on the footer', () => {
  test('the target read and write ride the bridge with a deadline', async () => {
    const seen: unknown[] = [];
    const usage: Usage = {
      thread: refused as Usage['thread'],
      compact: refused as Usage['compact'],
      compactionTarget: async (_call) => {
        seen.push('target');
        return { pressurePercent: 70 };
      },
      setCompactionTarget: async (input) => {
        seen.push(input);
        return { pressurePercent: input.pressurePercent };
      },
    };

    assert.deepEqual(await readCompactionTarget(usage), {
      pressurePercent: 70,
    });
    assert.deepEqual(await writeCompactionTarget(usage, 65), {
      pressurePercent: 65,
    });
    assert.deepEqual(seen, ['target', { pressurePercent: 65 }]);
  });

  test('the target write refuses what the host schema would refuse', async () => {
    let called = false;
    const usage: Usage = {
      thread: refused as Usage['thread'],
      compact: refused as Usage['compact'],
      compactionTarget: refused as Usage['compactionTarget'],
      setCompactionTarget: async () => {
        called = true;
        return { pressurePercent: 40 };
      },
    };

    await assert.rejects(writeCompactionTarget(usage, 40), {
      message: 'The compaction target must be a whole 50–95 percent.',
    });
    assert.equal(called, false);
    await assert.rejects(writeCompactionTarget(usage, 80.5), {
      message: 'The compaction target must be a whole 50–95 percent.',
    });
  });

  test('the compact call carries the thread id and answers in band', async () => {
    const seen: string[] = [];
    const usage: Usage = {
      thread: refused as Usage['thread'],
      compactionTarget: refused as Usage['compactionTarget'],
      setCompactionTarget: refused as Usage['setCompactionTarget'],
      compact: async (id) => {
        seen.push(id);
        return {
          status: 'compacted',
          condensedMessages: 12,
          retainedMessages: 3,
          tokensFreed: 4500,
        };
      },
    };
    const answered = await compactThread(usage, 'thread-1');
    assert.deepEqual(seen, ['thread-1']);
    assert.equal(
      compactResultMessage(answered),
      'Compacted 12 messages into one summary (about 4500 tokens freed).',
    );
  });

  test('manual compaction allows time for model generation beyond the read deadline', async () => {
    const now = Date.now();
    await compactThread(
      {
        ...source(refused as Usage['thread']),
        compact: async (_id, call) => {
          assert.ok(
            call && 'deadline' in call && typeof call.deadline === 'number',
          );
          assert.ok(call.deadline >= now + 300_000);
          assert.ok(call.deadline <= Date.now() + 300_000);
          return { status: 'refused', reason: 'nothing_to_compact' };
        },
      },
      'thread-1',
    );
  });

  test('the compact result reads as one sentence per status', () => {
    assert.equal(
      compactResultMessage({ status: 'refused', reason: 'disabled' }),
      'Context compaction is disabled in the settings.',
    );
    assert.equal(
      compactResultMessage({ status: 'refused', reason: 'nothing_to_compact' }),
      'Nothing condenses here: the recent conversation is already the smallest safe span.',
    );
    assert.equal(
      compactResultMessage({ status: 'failed', code: 'summarizer_failed' }),
      'The compaction failed (summarizer_failed); the log carries the attempt.',
    );
    assert.equal(
      compactResultMessage({ status: 'busy' }),
      'Wait for the active run (and the queued input) to finish.',
    );
  });
});
