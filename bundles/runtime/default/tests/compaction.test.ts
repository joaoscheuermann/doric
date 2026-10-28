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
  summarizedSpan,
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
  isContextOverflowError,
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

test('refuses to compact only an existing summary but allows new eligible messages', () => {
  const summary = user(
    checkpointMessage('Saved decisions', {
      start: 0,
      end: 10,
      trigger: 'manual',
    }),
  );
  const policy = { tailMinMessages: 2, summaryMaxChars: 1000 };
  assert.deepEqual(
    planCompaction([summary, user('recent one'), user('recent two')], policy),
    {
      status: 'refused',
      reason: 'nothing_to_compact',
    },
  );
  assert.equal(
    planCompaction(
      [summary, user('new content'), user('recent one'), user('recent two')],
      policy,
    ).status,
    'planned',
  );
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

void test('overflow recognition reads a provider error by its message, code and diagnostic', () => {
  const failure = (data: Record<string, unknown>) =>
    Object.assign(new Error(String(data.message)), { data });
  // Claude over HTTP: a generic message, the overflow in the body excerpt.
  assert.equal(
    isContextOverflowError(
      failure({
        message: 'claude request failed with HTTP 400.',
        diagnostic:
          '{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
      }),
    ),
    true,
  );
  // A stream error event carries the provider error itself.
  assert.equal(
    isContextOverflowError({
      message: 'Claude stream error.',
      code: 'model_context_window_exceeded',
    }),
    true,
  );
  assert.equal(
    isContextOverflowError(
      failure({ message: 'Overloaded.', code: 'overloaded_error' }),
    ),
    false,
  );
  assert.equal(isContextOverflowError(undefined), false);
});

void test('a condensation drops the bound thinking replay of the messages it keeps, and only that', () => {
  const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig' };
  const reasoning = { type: 'reasoning', encrypted_content: 'opaque' };
  const messages: ProviderMessage[] = [
    user('old question'),
    { role: 'assistant', content: 'old answer', replay: [thinking] },
    user('new question'),
    {
      role: 'assistant',
      content: 'new answer',
      replay: [thinking, { type: 'redacted_thinking', data: 'x' }],
    },
    { role: 'assistant', content: 'other provider', replay: [reasoning] },
  ];
  const result = rewritten(
    messages,
    { checkpoints: {}, messageCount: messages.length },
    user('[Context summary]\n\nsummary'),
    0,
    2,
  );

  assert.deepEqual(result.messages.slice(1), [
    user('new question'),
    { role: 'assistant', content: 'new answer' },
    { role: 'assistant', content: 'other provider', replay: [reasoning] },
  ]);
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

/** A standing instruction, as the run stores a retained bundle steer. */
const instruction = user(
  '<bundle-instruction bundle="default" reason="coding-workflow">\nRules.\n</bundle-instruction>',
);

void test('a retained message of the span stays verbatim after the summary, and every index re-bases', () => {
  const messages = [user('a'), instruction, user('b'), user('c'), user('d')];
  const applied = applyCompaction({
    messages,
    meta: {
      checkpoints: { late: 3 },
      messageCount: 5,
      retained: { 'default:coding-workflow': 1 },
    },
    end: 3,
    trigger: 'automatic',
    summaryId: 'compaction-test',
    summary: 'facts',
  });

  assert.deepEqual(applied.rewritten.messages, [
    applied.summaryMessage,
    instruction,
    user('c'),
    user('d'),
  ]);
  assert.deepEqual(applied.replacement, [applied.summaryMessage, instruction]);
  assert.deepEqual(applied.rewritten.meta, {
    checkpoints: { late: 2 },
    messageCount: 4,
    retained: { 'default:coding-workflow': 1 },
  });
  assert.equal(applied.condensation.condensedMessages, 2);
  assert.equal(applied.condensation.retainedMessages, 4);
});

void test('a retained message past the span re-bases like a boundary', () => {
  const messages = [user('a'), user('b'), user('c'), instruction];
  const result = rewritten(
    messages,
    {
      checkpoints: {},
      messageCount: 4,
      retained: { 'default:coding-workflow': 3 },
    },
    user('summary'),
    0,
    2,
  );

  assert.equal(
    result.messages[result.meta.retained?.['default:coding-workflow'] ?? -1],
    instruction,
  );
});

void test('the summarizer never reads a retained message', () => {
  const messages = [user('a'), instruction, user('b'), user('c')];

  assert.deepEqual(
    summarizedSpan(messages, { retained: { 'default:coding-workflow': 1 } }, 3),
    [user('a'), user('b')],
  );
});

void test('a span of only earlier summaries and retained messages has nothing to compact', () => {
  const summary = user(
    checkpointMessage('Saved decisions', {
      start: 0,
      end: 4,
      trigger: 'manual',
    }),
  );

  assert.deepEqual(
    planCompaction(
      [summary, instruction, user('recent one'), user('recent two')],
      policy,
      { retained: { 'default:coding-workflow': 1 } },
    ),
    { status: 'refused', reason: 'nothing_to_compact' },
  );
});

/*
 * A retained message the rewrite swaps instead of keeping (the loaded skills):
 * the condensed span's old one goes, the new one follows the summary and the
 * other retained messages kept, and every index re-bases around it.
 */

const oldSkills = user(
  '<bundle-instruction bundle="default" reason="loaded-skills">\nOld.\n</bundle-instruction>',
);
const newSkills = user(
  '<bundle-instruction bundle="default" reason="loaded-skills">\nNew.\n</bundle-instruction>',
);

void test('R1 swaps the retained message under the key for the new one, after the other kept retained messages, and re-bases the rest', () => {
  const messages = [
    user('a'),
    instruction,
    oldSkills,
    user('b'),
    user('c'),
    user('d'),
    user('later'),
  ];
  const applied = applyCompaction({
    messages,
    meta: {
      checkpoints: { early: 3, late: 5 },
      messageCount: 7,
      retained: {
        'default:coding-workflow': 1,
        'default:loaded-skills': 2,
        'test:later': 6,
      },
    },
    end: 5,
    trigger: 'automatic',
    summaryId: 'compaction-test',
    summary: 'facts',
    replace: { key: 'default:loaded-skills', message: newSkills },
  });

  assert.deepEqual(applied.rewritten.messages, [
    applied.summaryMessage,
    instruction,
    newSkills,
    user('d'),
    user('later'),
  ]);
  assert.deepEqual(applied.replacement, [
    applied.summaryMessage,
    instruction,
    newSkills,
  ]);
  assert.deepEqual(applied.rewritten.meta, {
    checkpoints: { late: 3 },
    messageCount: 5,
    retained: {
      'default:coding-workflow': 1,
      'default:loaded-skills': 2,
      'test:later': 4,
    },
  });
  assert.equal(applied.condensation.retainedMessages, 5);
});

void test('R1 drops the retained message under the key and inserts nothing when the swap has no message', () => {
  const messages = [
    user('a'),
    instruction,
    oldSkills,
    user('b'),
    user('c'),
    user('d'),
    user('later'),
  ];
  const applied = applyCompaction({
    messages,
    meta: {
      checkpoints: { late: 5 },
      messageCount: 7,
      retained: {
        'default:coding-workflow': 1,
        'default:loaded-skills': 2,
        'test:later': 6,
      },
    },
    end: 5,
    trigger: 'automatic',
    summaryId: 'compaction-test',
    summary: 'facts',
    replace: { key: 'default:loaded-skills' },
  });

  assert.deepEqual(applied.rewritten.messages, [
    applied.summaryMessage,
    instruction,
    user('d'),
    user('later'),
  ]);
  assert.deepEqual(applied.rewritten.meta, {
    checkpoints: { late: 2 },
    messageCount: 4,
    retained: { 'default:coding-workflow': 1, 'test:later': 3 },
  });
  assert.equal(applied.condensation.retainedMessages, 4);
});

void test('R1 adds the new message after the kept retained ones when the span held none under the key', () => {
  const messages = [user('a'), instruction, user('b'), user('c'), user('d')];
  const applied = applyCompaction({
    messages,
    meta: {
      checkpoints: { late: 4 },
      messageCount: 5,
      retained: { 'default:coding-workflow': 1 },
    },
    end: 3,
    trigger: 'automatic',
    summaryId: 'compaction-test',
    summary: 'facts',
    replace: { key: 'default:loaded-skills', message: newSkills },
  });

  assert.deepEqual(applied.rewritten.messages, [
    applied.summaryMessage,
    instruction,
    newSkills,
    user('c'),
    user('d'),
  ]);
  assert.deepEqual(applied.rewritten.meta, {
    checkpoints: { late: 4 },
    messageCount: 5,
    retained: { 'default:coding-workflow': 1, 'default:loaded-skills': 2 },
  });
});
