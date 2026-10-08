import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  NOTIFICATION_LINE_LIMIT,
  promptCompletion,
  watchingCompletion,
} from '../src/domain/notifications';
import type { ThreadEvent } from '../src/domain/workspace';

const finished = (value: Readonly<Record<string, unknown>>): ThreadEvent => ({
  projectId: 'project',
  threadId: 'thread',
  promptId: 'prompt',
  sequence: 1,
  type: 'prompt.finished',
  event: { type: 'prompt.finished', ...value },
  createdAt: '2026-01-01T00:00:01.000Z',
});

describe('what a finished prompt notifies', () => {
  test('names the Thread and the outcome beside the answer', () => {
    assert.deepEqual(
      promptCompletion(
        finished({
          status: 'completed',
          text: 'Fixed the failing test\nand shipped it.',
        }),
        'Main',
      ),
      {
        title: 'Main',
        body: 'Prompt completed · Fixed the failing test and shipped it.',
      },
    );
  });

  test('names the outcome alone when the prompt states no answer', () => {
    assert.deepEqual(
      promptCompletion(finished({ status: 'completed', text: '' }), 'Main'),
      { title: 'Main', body: 'Prompt completed' },
    );
  });

  test('reads a failure and a cancellation as their own outcomes', () => {
    assert.equal(
      promptCompletion(
        finished({ status: 'failed', text: 'The prompt failed.' }),
        'Main',
      )?.body,
      'Prompt failed · The prompt failed.',
    );
    assert.equal(
      promptCompletion(finished({ status: 'cancelled', text: '' }), 'Main')
        ?.body,
      'Prompt cancelled',
    );
  });

  test('bounds the answer to one line', () => {
    const answer = 'x'.repeat(NOTIFICATION_LINE_LIMIT + 40);
    assert.equal(
      promptCompletion(finished({ status: 'completed', text: answer }), 'Main')
        ?.body,
      `Prompt completed · ${'x'.repeat(NOTIFICATION_LINE_LIMIT)}`,
    );
  });

  test('stays silent for every event that is not a completion', () => {
    const started: ThreadEvent = {
      ...finished({ status: 'completed', text: 'done' }),
      type: 'agent.started',
      event: { type: 'agent.started' },
    };
    assert.equal(promptCompletion(started, 'Main'), undefined);
  });
});

describe('when a completion stays quiet', () => {
  test('is quiet for the Thread the focused window shows', () => {
    assert.equal(watchingCompletion('thread', 'thread', true), true);
  });

  test('is announced for another Thread or an unfocused window', () => {
    assert.equal(watchingCompletion('thread', 'other', true), false);
    assert.equal(watchingCompletion('thread', 'thread', false), false);
    assert.equal(watchingCompletion('thread', undefined, true), false);
  });
});
