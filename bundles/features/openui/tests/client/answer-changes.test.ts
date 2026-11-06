// C14 (conversation-openui.md D21): the live changes of the questions open
// in this window. Chat's `onThreadUpdateHook` hands every live event of a held
// Thread to `noticeThreadUpdate`, which calls each watch whose target
// `rereadsAnswer` accepts for that event: an `openui.answered/v1` row of the
// target's prompt, or a `history.truncated` row of the target's Thread.

import './support/dom.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatThreadEvent } from '../../src/client/chat-contract.js';
import type {
  AnswerTarget,
  WatchAnswers,
} from '../../src/client/chunks/renderer.js';

/** What `src/client/answer-changes.ts` exports (D21): the rule, the hook handler and the watches. */
interface AnswerChanges {
  rereadsAnswer(event: ChatThreadEvent, target: AnswerTarget): boolean;
  noticeThreadUpdate(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly threadName: string;
    readonly update:
      | { readonly kind: 'event'; readonly event: ChatThreadEvent }
      | { readonly kind: 'updated'; readonly thread: unknown };
  }): void;
  readonly watchAnswers: WatchAnswers;
}

const load = async (): Promise<AnswerChanges> =>
  (await import(
    new URL('../../src/client/answer-changes.js', import.meta.url).href
  )) as AnswerChanges;

const projectId = 'project-1';
const threadId = 'thread-1';
const target: AnswerTarget = { projectId, threadId, promptId: 'q1' };

const row = (
  type: string,
  payload: Record<string, unknown>,
  at: {
    readonly projectId?: string;
    readonly threadId?: string;
    readonly promptId?: string;
  } = {},
): ChatThreadEvent => ({
  projectId: at.projectId ?? projectId,
  threadId: at.threadId ?? threadId,
  promptId: at.promptId ?? 'a1',
  sequence: 7,
  type,
  event: { type, ...payload },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const answered = (questionPromptId: string, at = {}) =>
  row(
    'openui.answered/v1',
    { questionPromptId, digest: 'a'.repeat(64), answers: [] },
    at,
  );

const truncated = (at = {}) => row('history.truncated', { promptId: 'p2' }, at);

const update = (event: ChatThreadEvent) => ({
  projectId: event.projectId,
  threadId: event.threadId,
  threadName: 'Thread',
  update: { kind: 'event' as const, event },
});

test("rereadsAnswer accepts an answered row of the target's prompt and a truncation of its Thread", async () => {
  const { rereadsAnswer } = await load();

  assert.equal(rereadsAnswer(answered('q1'), target), true);
  assert.equal(rereadsAnswer(truncated(), target), true);
});

test('rereadsAnswer rejects a row of another prompt, another Thread and another type', async () => {
  const { rereadsAnswer } = await load();

  assert.equal(rereadsAnswer(answered('q2'), target), false);
  assert.equal(
    rereadsAnswer(answered('q1', { threadId: 'thread-2' }), target),
    false,
  );
  assert.equal(
    rereadsAnswer(truncated({ threadId: 'thread-2' }), target),
    false,
  );
  assert.equal(
    rereadsAnswer(answered('q1', { projectId: 'project-2' }), target),
    false,
  );
  assert.equal(rereadsAnswer(row('text.delta', { text: 'q1' }), target), false);
  assert.equal(
    rereadsAnswer(row('threads.answered/v1', { askId: 'q1' }), target),
    false,
  );
});

test('noticeThreadUpdate calls each matching watch once, and the others still when one throws', async () => {
  const { noticeThreadUpdate, watchAnswers } = await load();
  const calls: string[] = [];

  const releases = [
    watchAnswers(target, () => {
      calls.push('first');
      throw new Error('a listener broke');
    }),
    watchAnswers(target, () => {
      calls.push('second');
    }),
    watchAnswers({ ...target, promptId: 'q2' }, () => {
      calls.push('other prompt');
    }),
    watchAnswers({ ...target, threadId: 'thread-2' }, () => {
      calls.push('other thread');
    }),
  ];
  const errors = console.error;
  console.error = () => undefined;

  try {
    assert.doesNotThrow(() => noticeThreadUpdate(update(answered('q1'))));
  } finally {
    console.error = errors;
  }

  assert.deepEqual(calls.sort(), ['first', 'second']);
  for (const release of releases) release();
});

test('an updated record calls no one', async () => {
  const { noticeThreadUpdate, watchAnswers } = await load();
  let calls = 0;
  const release = watchAnswers(target, () => {
    calls += 1;
  });

  noticeThreadUpdate({
    projectId,
    threadId,
    threadName: 'Thread',
    update: { kind: 'updated', thread: {} },
  });

  assert.equal(calls, 0);
  release();
});

test('a released watch is not called', async () => {
  const { noticeThreadUpdate, watchAnswers } = await load();
  let calls = 0;
  const release = watchAnswers(target, () => {
    calls += 1;
  });

  noticeThreadUpdate(update(truncated()));
  release();
  release();
  noticeThreadUpdate(update(truncated()));

  assert.equal(calls, 1);
});
