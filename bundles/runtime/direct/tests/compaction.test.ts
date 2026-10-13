import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderMessage } from 'llms';

import {
  isSafeBoundary,
  largestSafeBoundaryAtOrBefore,
  safeBoundaries,
} from '../src/host/compaction/boundaries.js';
import {
  applyCompaction,
  newSummaryId,
  planCompaction,
} from '../src/host/compaction/compact.js';
import { CompactionError } from '../src/host/compaction/errors.js';
import {
  checkpointMarker,
  checkpointMessage,
  isCompactionCheckpoint,
  summaryBody,
} from '../src/host/compaction/markers.js';
import {
  isContextOverflow,
  projection,
} from '../src/host/compaction/project.js';
import {
  condensibleEnd,
  hasCheckpoint,
  rebasedCheckpoints,
  rewritten,
} from '../src/host/compaction/rewrite.js';
import { createSummarizer } from '../src/host/compaction/summarize.js';

const user = (text: string): ProviderMessage => ({
  role: 'user',
  content: text,
});
const assistant = (
  text: string,
  callIds: readonly string[],
): ProviderMessage => ({
  role: 'assistant',
  content: text,
  toolCalls: callIds.map((id) => ({ id, name: 'tool', arguments: '{}' })),
});
const tool = (id: string, text: string): ProviderMessage => ({
  role: 'tool',
  toolCallId: id,
  content: text,
});

const policy = { tailMinMessages: 2, summaryMaxChars: 6000 };

void test('index 0 is always a safe cut and a complete tool pair keeps one', () => {
  const messages = [
    user('a'),
    assistant('b', ['t1']),
    tool('t1', 'r'),
    user('c'),
  ];
  assert.deepEqual(safeBoundaries(messages), [0, 1, 3, 4]);
  assert.equal(isSafeBoundary(messages, 3), true);
});

void test('a cut between a call and its result is unsafe', () => {
  const messages = [user('a'), assistant('b', ['t1']), tool('t1', 'r')];
  assert.equal(isSafeBoundary(messages, 1), true);
  assert.equal(isSafeBoundary(messages, 2), false);
  assert.equal(isSafeBoundary(messages, 3), true);
});

void test('an orphan tool result corrupts every cut after it', () => {
  const messages = [user('a'), tool('t0', 'orphan'), user('b')];
  assert.deepEqual(safeBoundaries(messages), [0, 1]);
  assert.equal(largestSafeBoundaryAtOrBefore(messages, 2), 1);
});

void test('the condensible end respects the protected tail', () => {
  const messages = [
    user('0'),
    user('1'),
    user('2'),
    user('3'),
    user('4'),
    user('5'),
  ];
  assert.equal(condensibleEnd(messages, 2), 4);
  assert.equal(condensibleEnd(messages, 6), undefined);
  assert.equal(condensibleEnd([], 2), undefined);
});

void test('the condensible end falls back to the largest safe cut, never splitting a pair', () => {
  const messages = [
    user('0'),
    user('1'),
    assistant('call', ['t1']),
    tool('t1', 'r'),
    user('2'),
  ];
  // The tail wants to end at index 3, but only index 2 is safe before it.
  assert.equal(condensibleEnd(messages, 2), 2);
});

void test('checkpoints re-base across the removed span and drop inside it', () => {
  const meta = {
    checkpoints: { p0: 0, p1: 2, p2: 4, p3: 5 },
    messageCount: 5,
  };
  const rebased = rebasedCheckpoints(meta, 0, 3);
  // p0 and p1 open the condensed span and are dropped; the survivors gain
  // one back for the summary message that now precedes the tail.
  assert.deepEqual(rebased, { p2: 2, p3: 3 });
});

void test('the rewrite places the summary and keeps the tail in order', () => {
  const messages = [user('a'), user('b'), user('c'), user('d')];
  const summary: ProviderMessage = { role: 'user', content: 'summary' };
  const result = rewritten(
    messages,
    { checkpoints: { p3: 4 }, messageCount: 4 },
    summary,
    0,
    3,
  );
  assert.deepEqual(result.messages, [summary, user('d')]);
  assert.equal(result.meta.messageCount, 2);
  assert.deepEqual(result.meta.checkpoints, { p3: 2 });
});

void test('the marker marks only user messages that start with the marker line', () => {
  const summary = user(
    checkpointMessage('facts', { start: 0, end: 4, trigger: 'manual' }),
  );
  assert.equal(isCompactionCheckpoint(summary), true);
  assert.equal(
    isCompactionCheckpoint({ role: 'assistant', content: checkpointMarker }),
    false,
  );
  assert.equal(summaryBody(summary), 'facts');
  assert.equal(summaryBody(user(checkpointMarker)), undefined);
  assert.equal(hasCheckpoint([summary]), true);
  assert.equal(hasCheckpoint([user('plain')]), false);
});

void test('the projection measures the window and falls back to the char budget', () => {
  const long = 'x'.repeat(10_000);
  const withWindow = projection({
    messages: [user(long)],
    promptChars: 0,
    lastInputTokens: 500,
    lastOutputTokens: 500,
    contextWindow: 1000,
    charBudget: 1_000_000,
    pressurePercent: 80,
  });
  assert.equal(withWindow.underPressure, true);
  const calm = projection({
    messages: [user('short')],
    promptChars: 0,
    lastInputTokens: 10,
    lastOutputTokens: 10,
    contextWindow: 100_000,
    charBudget: 1_000_000,
    pressurePercent: 80,
  });
  assert.equal(calm.underPressure, false);
  const budgeted = projection({
    messages: [user('y'.repeat(200_000 * 4))],
    promptChars: 0,
    charBudget: 200_000,
    pressurePercent: 80,
  });
  assert.equal(budgeted.underPressure, true);
});

void test("overflow recognition reads the provider's wording", () => {
  assert.equal(
    isContextOverflow("This model's maximum context length is 8192 tokens"),
    true,
  );
  assert.equal(
    isContextOverflow('prompt is too long: 300000 tokens > 200000'),
    true,
  );
  assert.equal(isContextOverflow('server unavailable'), false);
});

void test('planning refuses an empty history and a history with no safe span', () => {
  assert.deepEqual(planCompaction([], policy), {
    status: 'refused',
    reason: 'missing_history',
  });
  assert.deepEqual(planCompaction([user('only')], policy), {
    status: 'refused',
    reason: 'nothing_to_compact',
  });
  assert.deepEqual(planCompaction([user('a'), user('b'), user('c')], policy), {
    status: 'planned',
    end: 1,
  });
});

void test('applying revalidates the cut and refuses a moved unsafe boundary', () => {
  const messages = [user('a'), user('b'), assistant('c', ['t1'])];
  assert.throws(
    () =>
      applyCompaction({
        messages,
        meta: { checkpoints: {}, messageCount: 3 },
        end: 3,
        trigger: 'manual',
        summaryId: 'compaction-test',
        summary: 'facts',
      }),
    (error: unknown) =>
      error instanceof CompactionError && error.code === 'unsafe_boundary',
  );
});

void test('applying produces the marked summary, the rewrite and the accounting', () => {
  const messages = [user('a'), user('b'), user('c')];
  const applied = applyCompaction({
    messages,
    meta: { checkpoints: {}, messageCount: 3 },
    end: 2,
    trigger: 'automatic',
    summaryId: 'compaction-test',
    summary: 'facts',
  });
  const content = applied.summaryMessage.content as string;
  assert.equal(content.startsWith(checkpointMarker), true);
  assert.equal(applied.condensation.condensedMessages, 2);
  assert.equal(applied.condensation.retainedMessages, 2);
  assert.deepEqual(applied.rewritten.messages, [
    applied.summaryMessage,
    user('c'),
  ]);
});

void test('summary ids are unique', () => {
  assert.notEqual(newSummaryId(), newSummaryId());
});

void test('the summarizer builds one marked-capped summary over the transcript', async () => {
  const seen: { system: string; transcript: string; signal?: AbortSignal }[] =
    [];
  const summarizer = createSummarizer({
    complete: async (input, signal) => {
      seen.push({ ...input, signal });
      return 'condensed facts';
    },
    summaryMaxChars: 6000,
  });
  const signal = new AbortController().signal;
  const summary = await summarizer.summarize(
    [user('hello'), tool('t1', 'done')],
    signal,
  );
  assert.equal(summary, 'condensed facts');
  assert.equal(seen.length, 1);
  assert.match(seen[0]?.transcript ?? '', /hello/);
  assert.match(seen[0]?.transcript ?? '', /t1/);
  assert.equal(seen[0]?.signal, signal);
});

void test('the summarizer caps the output at the paragraph boundary', async () => {
  const summarizer = createSummarizer({
    complete: async () =>
      'first paragraph\n\nsecond paragraph\n\nthird paragraph',
    summaryMaxChars: 'first paragraph\n\nsecond paragraph'.length,
  });
  const summary = await summarizer.summarize([user('x')]);
  assert.equal(summary.endsWith('[summary truncated]'), true);
});

void test('an empty summary fails the summarizer', async () => {
  const summarizer = createSummarizer({
    complete: async () => '   ',
    summaryMaxChars: 6000,
  });
  await assert.rejects(summarizer.summarize([user('x')]));
});
