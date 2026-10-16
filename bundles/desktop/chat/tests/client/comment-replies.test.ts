// The agent's answers to the reader's comments as the reader meets them in a
// window: each answer a row of the agent's turn, drawn like a tool call —
// `Replied to [n]`, the note it answers and the thread's state as one glyph,
// folded once the thread is resolved and open while the agent waits for the
// reader; the user turn's lines, which draw no state chip and read the
// thread's state out, following later resolutions live; and the event a line or a row's glyph dispatches for the
// bundle that owns the comment's target to open its thread on the target's
// latest drawing.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { ClientContext } from 'bundle/contracts';

import {
  ChatViewsV1,
  COMMENT_THREAD_OPEN_EVENT,
  type CommentThreadOpenDetail,
} from '../../src/contracts/index.js';
import {
  type ChatWindow,
  openChatWindow,
  type Probe,
  settle,
} from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

const thread = () => ({
  id: threadId,
  name: 'Review the checkout',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

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
  createdAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
});

const target = {
  kind: 'artifact',
  id: 'art_1',
  revision: 1,
  anchor: { form: 'point', x: 10, y: 20, label: 'Button' },
};

const call = { id: 'call-1', name: 'comment_reply', index: 0, payload: {} };

/** The reader's comment, the agent's answer through `comment_reply`, resolved. */
const answered = [
  event(1, {
    type: 'prompt.accepted',
    text: 'Ajusta o checkout',
    source: { kind: 'user' },
  }),
  event(2, {
    type: 'comments.added/v1',
    commentId: 'comment-a',
    target,
    text: 'aumenta o botão',
    author: 'jao.scheuermann',
  }),
  event(3, { type: 'text.delta', delta: 'Vou ajustar.' }),
  event(4, { type: 'tool.started', call }),
  event(5, {
    type: 'comments.added/v1',
    commentId: 'comment-r1',
    target,
    text: 'Aumentei o padding do botão.',
    author: 'agent',
    inReplyTo: 'comment-a',
  }),
  event(6, {
    type: 'comments.resolved/v1',
    commentId: 'comment-a',
    resolved: true,
  }),
  event(7, { type: 'tool.finished', call, record: { output: '{}' } }),
  event(8, {
    type: 'prompt.finished',
    status: 'completed',
    text: 'Vou ajustar.',
  }),
];

/** A preview of the target drawn in the conversation, at one revision. */
const preview = (sequence: number, revision: number) =>
  event(sequence, { type: 'probe.preview/v1', id: 'art_1', revision });

/** The bundle that draws previews: one block per revision, named by it. */
const previewProbe: Probe = {
  requires: ['chat.views/v1@^1.0.0'],
  activate: ({ services }: ClientContext) => {
    services.use(ChatViewsV1).registerProjector({
      eventTypes: ['probe.preview/v1'],
      initial: () => null,
      reduce: (
        state: null,
        entry: { sequence: number; promptId: string; event: unknown },
      ) => {
        const drawn = entry.event as { id: string; revision: number };
        return {
          state,
          blocks: [
            {
              id: `preview:${drawn.id}@${drawn.revision}`,
              type: 'probe.preview',
              promptId: entry.promptId,
              sequence: entry.sequence,
              data: drawn,
            },
          ],
        };
      },
    } as never);
  },
};

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Opens the Thread and delivers its log. */
const open = async (
  events: readonly unknown[],
  probe?: Probe,
): Promise<ChatWindow> => {
  opened = await openChatWindow({
    url,
    host: {
      'runtime.threads/v1.thread': () => thread(),
      'runtime.threads/v1.queue': () => ({
        revision: 1,
        paused: false,
        stopping: false,
        items: [],
      }),
    },
    ...(probe === undefined ? {} : { probe }),
  });
  opened.watches().at(-1)?.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events,
  });
  await settle(200);
  return opened;
};

/** Pushes one more event of the log, live. */
const push = async (window: ChatWindow, value: unknown): Promise<void> => {
  window.watches().at(-1)?.push({ kind: 'event', event: value });
  await settle(200);
};

const row = (window: ChatWindow): HTMLElement | null =>
  window.document.querySelector('[data-reply-root="comment-a"]');

/** The row's header, the toggle that folds and unfolds the answer. */
const header = (window: ChatWindow): HTMLButtonElement | null =>
  row(window)?.querySelector('button[aria-label^="Replied to"]') ?? null;

/** The glyph at the row's end, which opens the thread. */
const glyph = (window: ChatWindow): HTMLButtonElement | null =>
  row(window)?.querySelector('button[data-comment-state]') ?? null;

/** Whether the row shows the agent's words. */
const showsAnswer = (window: ChatWindow): boolean =>
  /Aumentei o padding do botão\./.test(row(window)?.textContent ?? '');

/** The sent comment's line in the user turn: a button of its own. */
const line = (window: ChatWindow): HTMLButtonElement | null =>
  window.document.querySelector('[data-turn-comments] button');

/** What the sent comment's line reads out: its note, then its thread's state. */
const spoken = (window: ChatWindow): string =>
  line(window)?.getAttribute('aria-label') ?? '';

/** Every thread the window asks to open. */
const asked = (window: ChatWindow): CommentThreadOpenDetail[] => {
  const seen: CommentThreadOpenDetail[] = [];
  window.document.addEventListener(COMMENT_THREAD_OPEN_EVENT, (event) => {
    seen.push((event as CustomEvent<CommentThreadOpenDetail>).detail);
  });
  return seen;
};

const { revision: _revision, ...latestTarget } = target;

test("the agent's answer is a row of its turn, after its words, naming the comment it answers by its pin and note", async () => {
  const window = await open(answered);

  const reply = row(window);
  assert.ok(reply, 'the reply row stands in the transcript');
  assert.match(
    header(window)?.textContent ?? '',
    /Replied to\s*\[1\]\s*aumenta o botão/,
  );
  // It stands where the agent wrote it: after the words before the call.
  const words = [
    ...window.document.querySelectorAll('[data-lexical-editor] *'),
  ].find((element) => element.textContent === 'Vou ajustar.');
  assert.ok(words);
  assert.equal(
    words.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  // The row replaces the call's own row, and speaks the chat's English.
  assert.doesNotMatch(
    window.document.body.textContent ?? '',
    /comment_reply|resolvido|aguardando|Abrir thread|Responder/,
  );
});

test('a resolved thread folds its row to the glyph `✓`, and the reader opens it', async () => {
  const window = await open(answered);

  assert.equal(glyph(window)?.textContent, '✓');
  assert.equal(showsAnswer(window), false);

  header(window)?.click();
  await settle(50);

  assert.equal(showsAnswer(window), true);
});

test('a thread waiting for the reader opens its row with the glyph `?`, and a later resolution folds it', async () => {
  const window = await open(answered);
  await push(
    window,
    event(9, {
      type: 'comments.resolved/v1',
      commentId: 'comment-a',
      resolved: false,
    }),
  );

  assert.equal(glyph(window)?.textContent, '?');
  assert.match(spoken(window), /waiting on you, 1 reply$/);
  // The line draws no chip: the reply row's glyph is where the state shows.
  assert.equal(
    window.document.querySelector('[data-turn-comments] [data-comment-state]'),
    null,
  );
  assert.equal(showsAnswer(window), true);

  await push(
    window,
    event(10, {
      type: 'comments.resolved/v1',
      commentId: 'comment-a',
      resolved: true,
    }),
  );

  assert.equal(glyph(window)?.textContent, '✓');
  assert.match(spoken(window), /resolved, 1 reply$/);
  assert.equal(showsAnswer(window), false);
});

test("the reader's choice on a row stands over a later change of its thread", async () => {
  const window = await open(answered);
  header(window)?.click();
  await settle(50);

  await push(
    window,
    event(9, {
      type: 'comments.resolved/v1',
      commentId: 'comment-a',
      resolved: false,
    }),
  );
  await push(
    window,
    event(10, {
      type: 'comments.resolved/v1',
      commentId: 'comment-a',
      resolved: true,
    }),
  );

  assert.equal(showsAnswer(window), true);
});

test("clicking a sent comment's line opens its thread on the latest preview of its target", async () => {
  const window = await open(
    [...answered, preview(9, 1), preview(10, 2)],
    previewProbe,
  );
  const seen = asked(window);

  line(window)?.click();
  await settle(20);

  assert.deepEqual(seen, [{ commentId: 'comment-a', target: latestTarget }]);
  const flashed = [
    ...window.document.querySelectorAll('[data-chat-block-id]'),
  ].filter((block) => block.hasAttribute('data-comment-flash'));
  assert.deepEqual(
    flashed.map((block) => block.getAttribute('data-chat-block-id')),
    ['preview:art_1@2'],
  );
});

test("a row's glyph opens the thread on the latest preview too, without folding the row", async () => {
  const window = await open(answered);
  const seen = asked(window);

  glyph(window)?.click();
  await settle(20);

  assert.deepEqual(seen, [{ commentId: 'comment-a', target: latestTarget }]);
  assert.equal(showsAnswer(window), false);
});
