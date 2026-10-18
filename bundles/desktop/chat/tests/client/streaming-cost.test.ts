// What streaming one answer costs the reader's window: the built chat in a
// happy-dom window, fed through the Thread watch exactly as main's bridge
// would feed it, in the batches a 100ms flush window carries. The timings are
// reported through diagnostics rather than asserted, since they depend on the
// machine; the assertions carry only what streaming must always do — the answer
// the log holds is the answer the conversation draws, whole.
//
// The runs answer two questions. What does one flush cost as the answer grows
// (only the tail the answer outgrew is rebuilt, so the cost should track the
// batch's delta, not the answer)? And what does one flush
// cost as the conversation grows (the transcript a flush walks is the whole
// conversation, not the batch)? A window paid per flush is a window that
// stutters while an answer streams, which is the only state a reader watches
// the surface in.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { ClientContext } from 'bundle/contracts';
import { defineExtension, type LexicalEditor } from 'lexical';

import { ChatLexicalV1 } from '../../src/contracts/index.js';
import { type ChatWindow, openChatWindow, settle } from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const path = `/projects/${projectId}/threads/${threadId}`;
const url = `doric://app${path}`;

const thread = () => ({
  id: threadId,
  name: 'Cost',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const emptyQueue = { revision: 1, paused: false, stopping: false, items: [] };

const host = {
  'runtime.threads/v1.thread': () => thread(),
  'runtime.threads/v1.queue': () => emptyQueue,
};

const event = (
  sequence: number,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
) => ({
  projectId,
  threadId,
  promptId,
  sequence,
  type: value.type,
  event: value,
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

/**
 * One finished exchange for the transcript the window opens on: the reader's
 * question, the answer streamed as deltas, and the finished event that makes
 * the answer authoritative.
 */
const exchange = (
  sequences: { sequence: number },
  index: number,
  kilobytes: number,
): readonly unknown[] => {
  const text = answer(kilobytes, index);
  const events = [
    event(sequences.sequence++, {
      type: 'prompt.accepted',
      text: `Question ${index} about the parser`,
      source: { kind: 'user' },
    }),
    ...chunksOf(text, 16).map((delta) =>
      event(sequences.sequence++, { type: 'text.delta', delta }),
    ),
    event(sequences.sequence++, {
      type: 'prompt.finished',
      status: 'completed',
      text,
    }),
  ];
  return events;
};

/** The whole transcript of `exchanges` answers, the log a snapshot delivers. */
const transcript = (exchanges: number): readonly unknown[] => {
  const sequences = { sequence: 1 };
  return Array.from({ length: exchanges }, (_, index) =>
    exchange(sequences, index, 2),
  ).flat();
};

/**
 * The answer one live run streams, split into the batches a 100ms flush window
 * carries: eight deltas each, and the finished event that makes the answer
 * authoritative. Each batch carries the answer's size once it is held, so the
 * cost of a flush reads against the text the flush had to seat.
 */
const run = (
  sequences: { sequence: number },
  kilobytes: number,
): readonly {
  readonly events: readonly unknown[];
  readonly held: number;
}[] => {
  const text = answer(kilobytes, 999);
  const deltas = chunksOf(text, Math.round(kilobytes * 4));
  const batches: { events: readonly unknown[]; held: number }[] = [];
  let held = 0;
  for (let index = 0; index < deltas.length; index += 8) {
    const window = deltas.slice(index, index + 8);
    held += window.reduce((sum, delta) => sum + delta.length, 0);
    batches.push({
      events: window.map((delta) =>
        event(sequences.sequence++, { type: 'text.delta', delta }),
      ),
      held,
    });
  }
  batches.push({
    events: [
      event(sequences.sequence++, {
        type: 'prompt.finished',
        status: 'completed',
        text,
      }),
    ],
    held: text.length,
  });
  return batches;
};

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** CPU and wall time one stretch of work took, in milliseconds. */
const timed = async (
  work: () => Promise<void>,
): Promise<{ readonly cpu: number; readonly wall: number }> => {
  const before = process.cpuUsage();
  const started = performance.now();
  await work();
  const { user, system } = process.cpuUsage(before);
  return { cpu: (user + system) / 1000, wall: performance.now() - started };
};

/** Every timing of a series in one line: first, median, last, average. */
const line = (timings: readonly number[]): string => {
  const sorted = [...timings].sort((left, right) => left - right);
  const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const total = sorted.reduce((sum, one) => sum + one, 0);
  return `first ${sorted[0]?.toFixed(1)} ms, median ${middle.toFixed(
    1,
  )} ms, last ${sorted.at(-1)?.toFixed(1)} ms, avg ${(total / sorted.length).toFixed(1)} ms`;
};

test('the window streams an answer into an empty conversation', async (context) => {
  let editor: LexicalEditor | undefined;
  opened = await openChatWindow({
    url,
    host,
    probe: {
      requires: ['chat.lexical/v1@^1.0.0'],
      activate: ({ services }: ClientContext) => {
        services.use(ChatLexicalV1).registerExtension(
          defineExtension({
            name: 'cost/stream',
            register: (value) => {
              editor = value;
              return () => {};
            },
          }),
        );
      },
    },
  });
  const watch = opened.watches().at(-1);
  assert.ok(watch);
  watch.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events: [],
  });
  await settle();

  const batches = run({ sequence: 1 }, 16);
  const series: string[] = [];
  const perBatch: number[] = [];
  for (const batch of batches) {
    const { cpu } = await timed(async () => {
      for (const item of batch.events)
        watch.push({ kind: 'event', event: item });
      await settle(150);
    });
    perBatch.push(cpu);
    series.push(`${(batch.held / 1024).toFixed(0)}KB=${cpu.toFixed(0)}ms`);
  }
  const text = opened.document.querySelector('chat-view')?.textContent ?? '';
  assert.match(
    text,
    /A closing paragraph with a \[link\]/,
    'the streamed answer lands whole',
  );
  const total = perBatch.reduce((sum, one) => sum + one, 0);
  context.diagnostic(
    `0 exchanges held: ${batches.length} flush batches of a 16KB answer — cpu per batch ${line(
      perBatch,
    )}; total ${total.toFixed(0)} ms; per batch [${series.join(', ')}]`,
  );
  assert.ok(editor);
});

test('the window streams an answer into a long conversation', async (context) => {
  let editor: LexicalEditor | undefined;
  opened = await openChatWindow({
    url,
    host,
    probe: {
      requires: ['chat.lexical/v1@^1.0.0'],
      activate: ({ services }: ClientContext) => {
        services.use(ChatLexicalV1).registerExtension(
          defineExtension({
            name: 'cost/stream',
            register: (value) => {
              editor = value;
              return () => {};
            },
          }),
        );
      },
    },
  });

  // The transcript a long conversation opens on: sixty finished answers.
  const transcriptEvents = transcript(60);
  const mount = await timed(async () => {
    const watch = opened?.watches().at(-1);
    assert.ok(watch);
    watch.push({
      kind: 'snapshot',
      threadId,
      projectId,
      project: null,
      thread: thread(),
      events: transcriptEvents as never[],
    });
    await settle(800);
  });
  context.diagnostic(
    `mount: 60 exchanges (${transcriptEvents.length} events, ${(
      transcriptEvents.length * 2.3
    ).toFixed(
      0,
    )}KB) — cpu ${mount.cpu.toFixed(0)} ms, wall ${mount.wall.toFixed(0)} ms`,
  );

  const batches = run({ sequence: transcriptEvents.length + 1 }, 8);
  const perBatch: number[] = [];
  for (const batch of batches) {
    const { cpu } = await timed(async () => {
      const watch = opened?.watches().at(-1);
      for (const item of batch.events)
        watch?.push({ kind: 'event', event: item });
      await settle(150);
    });
    perBatch.push(cpu);
  }
  const text = opened.document.querySelector('chat-view')?.textContent ?? '';
  assert.match(
    text,
    /A closing paragraph with a \[link\]/,
    'the streamed answer lands whole',
  );
  const total = perBatch.reduce((sum, one) => sum + one, 0);
  context.diagnostic(
    `60 exchanges held: ${batches.length} flush batches of a 8KB answer — cpu per batch ${line(
      perBatch,
    )}; total ${total.toFixed(0)} ms`,
  );
  assert.ok(editor);
});
