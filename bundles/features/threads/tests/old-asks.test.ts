// C12 (D30): threads 2.0.0 keeps a projector that claims the two old ask
// events so stored `threads.asked/v1` and `threads.answered/v1` rows replay
// without a block and without an "unknown event" fallback.

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ChatThreadEvent,
  ProjectorSpec,
} from '../src/client/chat-contract.js';

/** What `src/client/old-asks.ts` exports. */
interface OldAsks {
  readonly oldAskProjector: ProjectorSpec<unknown>;
}

// Loaded by URL so the rest of the suite compiles while the module is absent.
const loadOldAsks = async (): Promise<OldAsks> =>
  (await import(
    new URL('../src/client/old-asks.js', import.meta.url).href
  )) as OldAsks;

const askId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf16a1';

const row = (
  type: string,
  sequence: number,
  payload: Record<string, unknown>,
): ChatThreadEvent => ({
  projectId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1600',
  threadId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601',
  promptId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602',
  sequence,
  type,
  event: { type, ...payload },
  createdAt: '2026-10-09T00:00:00.000Z',
});

void test('claims exactly the old asked and answered event types', async () => {
  const { oldAskProjector } = await loadOldAsks();

  assert.deepEqual(
    [...oldAskProjector.eventTypes],
    ['threads.asked/v1', 'threads.answered/v1'],
  );
});

void test('an asked row and then its answered row each draw no block', async () => {
  const { oldAskProjector } = await loadOldAsks();
  const asked = row('threads.asked/v1', 2, {
    askId,
    questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }],
  });
  const answered = row('threads.answered/v1', 3, {
    askId,
    answers: [{ questionId: 'q1', labels: ['A'] }],
  });

  const first = oldAskProjector.reduce(oldAskProjector.initial(), asked);
  const second = oldAskProjector.reduce(first.state, answered);

  assert.deepEqual(first.blocks, []);
  assert.deepEqual(second.blocks, []);
});
