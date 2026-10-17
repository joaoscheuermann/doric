// The CPU cost of streaming one answer into a conversation, measured where the
// work is decided rather than where the window draws it: the projector's read
// of a batch (what the store's 100ms flush calls on every batch) and the
// markdown parser a turn's rebuild reads. Both are reported through
// diagnostics rather than asserted, since elapsed time depends on the machine;
// the assertions carry only what the reads must always do.
//
// The question the numbers answer: does a flush cost the same wherever it
// lands in a conversation, or does it grow with what the conversation already
// holds? A per-flush cost that grows with the log makes streaming an answer
// slower the longer the thread is, and slower still the longer the answer
// runs, which is what a reader waiting on a long thread feels.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { markdownBlocks } from '../src/client/domain/markdown.js';
import { emptyProjection } from '../src/client/domain/projector.js';
import {
  applyThreadEvents,
  emptyThreadChats,
  type ThreadChats,
} from '../src/client/domain/thread-chats.js';
import type { Thread, ThreadEvent } from '../src/client/domain/workspace.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';

const thread: Thread = {
  id: threadId,
  name: 'Cost',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const envelope = (
  sequence: number,
  promptId: string,
  event: Readonly<Record<string, unknown> & { readonly type: string }>,
): ThreadEvent => ({
  projectId,
  threadId,
  promptId,
  sequence,
  type: event.type,
  event,
  createdAt: `2026-01-01T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
});

/** One answer of realistic markdown, `kilobytes` KB long, measured exactly. */
const answer = (kilobytes: number, index: number): string => {
  const unit = (part: number): string => `## Section ${index}.${part}

The parser reads the answer in blocks, and this paragraph carries enough
words to look like the ones a model writes when it explains itself.

- one item with **bold** runs
- another with \`inline code\`
- a third with *emphasis*

1. first ordered item
2. second ordered item

\`\`\`ts
const value = ${index}.${part};
export const read = (): number => value;
\`\`\`

| col | other |
| --- | --- |
| a ${part} | b |

A closing paragraph with a [link](https://example.com) and trailing text.`;

  const whole = Math.max(1, Math.ceil((kilobytes * 1024) / unit(0).length));
  return Array.from({ length: whole }, (_, part) => unit(part)).join('\n\n');
};

/** The answer cut where a model's tokens cut it, mid-word and mid-line. */
const chunksOf = (text: string, count: number): readonly string[] => {
  const size = Math.ceil(text.length / count);
  return Array.from({ length: count }, (_, index) =>
    text.slice(index * size, (index + 1) * size),
  ).filter((chunk) => chunk.length > 0);
};

/** One finished exchange: the reader's question and the agent's answer. */
const exchange = (
  sequences: { sequence: number },
  index: number,
  kilobytes = 2,
): readonly ThreadEvent[] => {
  const promptId = `prompt-${index}`;
  const text = answer(kilobytes, index);
  const accepted = envelope(sequences.sequence++, promptId, {
    type: 'prompt.accepted',
    text: `Question ${index} about the parser`,
    source: { kind: 'user' },
  });
  const deltas = chunksOf(text, 16).map((delta) =>
    envelope(sequences.sequence++, promptId, { type: 'text.delta', delta }),
  );
  const finished = envelope(sequences.sequence++, promptId, {
    type: 'prompt.finished',
    status: 'completed',
    text,
  });
  return [accepted, ...deltas, finished];
};

/** The whole transcript of `exchanges` finished exchanges, one log. */
const transcript = (
  exchanges: number,
  kilobytes = 2,
): readonly ThreadEvent[] => {
  const sequences = { sequence: 1 };
  return Array.from({ length: exchanges }, (_, index) =>
    exchange(sequences, index, kilobytes),
  ).flat();
};

/** One Thread's chat holding `state`'s log, open for batches to fold into. */
const openChat = (state: ThreadChats, events: readonly ThreadEvent[]) =>
  applyThreadEvents(
    {
      ...state,
      chats: new Map([
        ...state.chats,
        [
          threadId,
          {
            id: threadId,
            thread,
            projection: emptyProjection,
            error: undefined,
            sending: false,
            sendError: undefined,
            pending: undefined,
            subscribed: true,
          },
        ],
      ]),
    },
    threadId,
    events,
  ).chats;

const streamBatches = (
  state: ThreadChats,
  batches: readonly (readonly ThreadEvent[])[],
): { readonly state: ThreadChats; readonly perBatch: readonly number[] } => {
  const perBatch: number[] = [];
  for (const batch of batches) {
    const started = performance.now();
    state = applyThreadEvents(state, threadId, batch).chats;
    perBatch.push(performance.now() - started);
  }
  return { state, perBatch };
};

/** Every timing of a series in one line: first, median, last, average. */
const line = (perBatch: readonly number[]): string => {
  const sorted = [...perBatch].sort((left, right) => left - right);
  const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const total = sorted.reduce((sum, one) => sum + one, 0);
  return `first ${sorted[0]?.toFixed(2)} ms, median ${middle.toFixed(
    2,
  )} ms, last ${sorted.at(-1)?.toFixed(2)} ms, avg ${(total / sorted.length).toFixed(2)} ms`;
};

test('a flush costs the same wherever it lands in the log', (context) => {
  for (const exchanges of [10, 40, 160]) {
    const whole = transcript(exchanges);
    const state = openChat(emptyThreadChats, whole);
    assert.equal(
      state.chats.get(threadId)?.projection.turns.at(-1)?.type,
      'agent',
      'the transcript reads to a finished answer',
    );

    // One more answer arrives in the store's cadence: batches of 8 deltas,
    // the size a 100ms window of an active model carries.
    const stream = exchange({ sequence: whole.length + 1 }, exchanges, 4);
    const batches: (readonly ThreadEvent[])[] = [];
    for (let index = 1; index < stream.length - 1; index += 8)
      batches.push(stream.slice(index, index + 8));
    batches.push(stream.slice(-1)); // the closing finished event
    const { state: after, perBatch } = streamBatches(state, batches);

    const held = after.chats.get(threadId)?.projection.turns.length ?? 0;
    context.diagnostic(
      `${exchanges} exchanges held: ${perBatch.length} flush batches of a 4KB answer over ${held} turns — ${line(perBatch)}`,
    );
  }
});

test('the markdown parser reads an answer in linear time', (context) => {
  for (const kilobytes of [2, 8, 32, 128]) {
    const source = answer(kilobytes, 0);
    markdownBlocks(source); // warm
    const rounds = Math.max(5, Math.round(256 / kilobytes));
    const started = performance.now();
    for (let index = 0; index < rounds; index += 1) markdownBlocks(source);
    const each = (performance.now() - started) / rounds;
    context.diagnostic(
      `markdownBlocks ${kilobytes}KB: ${each.toFixed(2)} ms per read (${(
        each / kilobytes
      ).toFixed(3)} ms/KB)`,
    );
  }
});
