// The agent's answers to the reader's comments as the reader meets them in a
// window: each answer a row of the agent's turn, drawn like a tool call —
// `Replied to [n]`, the note it answers and the thread's state as its pin,
// folded once the thread is resolved and open while the agent waits for the
// reader; the user turn's comment group, whose cards draw no pin, read the
// thread's state out, following later resolutions live, and show the passage
// each comment is about; and where a card's "go to" leads: the answer's
// paragraph for words of it, else the event a card, or a row's pin header
// button, dispatches for the bundle that owns the comment's target to open its
// thread on the target's latest drawing.

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

/** The pin at the row's end, which opens the thread's popover. */
const pin = (window: ChatWindow): HTMLButtonElement | null =>
  row(window)?.querySelector('button[data-comment-pin]') ?? null;

/** The thread popover a pin opens; it portals out of the row. */
const popover = (window: ChatWindow): HTMLElement | null =>
  window.document.querySelector('[data-comment-thread="comment-a"]');

/** The popover's header button, which takes the reader to the comment in the canvas. */
const jump = (window: ChatWindow): HTMLButtonElement | null =>
  popover(window)?.querySelector('button[data-comment-jump]') ?? null;

/** Whether the row shows the agent's words. */
const showsAnswer = (window: ChatWindow): boolean =>
  /Aumentei o padding do botão\./.test(row(window)?.textContent ?? '');

/** The sent comment's card in the user turn. */
const line = (window: ChatWindow): HTMLElement | null =>
  window.document.querySelector('[data-turn-comments] [data-comment-line]');

/** The card's arrow, which goes to the comment's passage. */
const goTo = (window: ChatWindow): HTMLButtonElement | null =>
  line(window)?.querySelector(
    'button[aria-label="Go to the commented passage"]',
  ) ?? null;

/** What the sent comment's card reads out: the comment, then its thread's state. */
const spoken = (window: ChatWindow): string =>
  window.document.querySelector('[data-turn-comments] [data-comment-spoken]')
    ?.textContent ?? '';

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
    /Replied to:\s*aumenta o botão/,
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

test('a resolved thread folds its row, its pin wearing the done state, and the reader opens it', async () => {
  const window = await open(answered);

  assert.equal(pin(window)?.textContent, '1');
  assert.equal(pin(window)?.getAttribute('data-comment-state'), 'done');
  assert.equal(showsAnswer(window), false);

  header(window)?.click();
  await settle(50);

  assert.equal(showsAnswer(window), true);
});

test('a thread waiting for the reader opens its row, its pin wearing the await state, and a later resolution folds it', async () => {
  const window = await open(answered);
  await push(
    window,
    event(9, {
      type: 'comments.resolved/v1',
      commentId: 'comment-a',
      resolved: false,
    }),
  );

  assert.equal(pin(window)?.getAttribute('data-comment-state'), 'await');
  assert.equal(pin(window)?.textContent, '1');
  assert.match(spoken(window), /waiting on you, 1 reply$/);
  // The line draws no pin: the reply row's pin is where the state shows.
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

  assert.equal(pin(window)?.getAttribute('data-comment-state'), 'done');
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

test("a row's pin opens the thread's popover, and its header button reaches the latest preview without folding the row", async () => {
  const window = await open(answered);
  const seen = asked(window);

  pin(window)?.click();
  await settle(20);

  // The pin opens the thread in place; the canvas is not asked yet.
  assert.deepEqual(seen, []);
  assert.match(popover(window)?.textContent ?? '', /aumenta o botão/);
  assert.equal(showsAnswer(window), false);

  jump(window)?.click();
  await settle(20);

  assert.deepEqual(seen, [{ commentId: 'comment-a', target: latestTarget }]);
  assert.equal(showsAnswer(window), false);
});

/** The comment group that opens the sent turn. */
const group = (window: ChatWindow): HTMLElement | null =>
  window.document.querySelector('[data-turn-comments] [data-comment-group]');

/** The group's header, the toggle that folds its cards. */
const groupHeader = (window: ChatWindow): HTMLButtonElement | null =>
  group(window)?.querySelector('[data-comment-group-header]') ?? null;

test("a sent turn's comments open its block under the turn's own mark, behind a header that folds them", async () => {
  const window = await open(answered);

  // The comments wear the reader's mark in the turn's place, right above the
  // reader's words, which the sheet then draws without one.
  const comments = window.document.querySelector('[data-turn-comments]');
  const words = comments?.nextElementSibling;
  assert.equal(comments?.getAttribute('data-turn-avatar'), 'user');
  assert.equal(words?.getAttribute('data-turn-avatar'), 'user');
  assert.match(words?.textContent ?? '', /Ajusta o checkout/);

  const header = groupHeader(window);
  assert.ok(header);
  assert.equal(header.textContent, '1 comment');
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.ok(line(window), 'the card shows while the group is open');

  header.click();
  await settle(20);
  assert.equal(groupHeader(window)?.getAttribute('aria-expanded'), 'false');
  assert.equal(line(window), null, 'folded, the cards are gone');

  groupHeader(window)?.click();
  await settle(20);
  assert.ok(line(window));
});

test("a sent comment's card frames its note under the anchor's label when the anchor quotes no words, and draws no pin number", async () => {
  const window = await open(answered);

  const card = line(window);
  assert.ok(card);
  assert.equal(
    card.querySelector('[data-comment-excerpt]')?.textContent,
    'Button (10, 20)',
  );
  assert.equal(card.querySelector('[data-comment-quote]'), null);
  assert.equal(
    card.querySelector('[data-comment-frame]')?.textContent,
    'JSaumenta o botão',
  );
  assert.doesNotMatch(card.textContent ?? '', /\[1\]/, 'no pin number');
});

const answeredId = '44444444-4444-4444-8444-444444444444';

/** One event of the answered prompt before the one the comment rides on. */
const earlier = (
  sequence: number,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
) => ({ ...event(sequence, value), promptId: answeredId });

const ANSWER =
  'I see the placeholder text and a photo of an orange kitten. Are you testing messages and comments, or do you want me to change the checkout?';

/** An answer, then a prompt carrying one comment on words of it. */
const commentedAnswer = (
  anchor: Record<string, unknown>,
  answer: string = ANSWER,
) => [
  earlier(1, {
    type: 'prompt.accepted',
    text: 'Descreve a imagem',
    source: { kind: 'user' },
  }),
  earlier(2, { type: 'text.delta', delta: answer }),
  earlier(3, { type: 'prompt.finished', status: 'completed', text: answer }),
  event(4, {
    type: 'prompt.accepted',
    text: 'Esse é um prompt do usuário',
    source: { kind: 'user' },
  }),
  event(5, {
    type: 'comments.added/v1',
    commentId: 'comment-m',
    target: { kind: 'message', id: answeredId, anchor },
    text: 'asdasda',
    author: 'jao.scheuermann',
  }),
];

test('a sent comment on words of the answer reads them in their paragraph, the words highlighted', async () => {
  const window = await open(
    commentedAnswer({
      form: 'range',
      text: 'of an orange',
      turn: `agent:${answeredId}:2`,
      block: 0,
    }),
  );

  const card = line(window);
  assert.ok(card);
  assert.equal(
    card.querySelector('[data-comment-excerpt]')?.textContent,
    ANSWER,
  );
  assert.equal(
    card.querySelector('[data-comment-quote]')?.textContent,
    'of an orange',
  );
});

test('a sent comment whose paragraph the transcript does not draw shows its quote alone', async () => {
  const window = await open(
    commentedAnswer({ form: 'range', text: 'of an orange' }),
  );

  const card = line(window);
  assert.ok(card);
  assert.equal(
    card.querySelector('[data-comment-excerpt]')?.textContent,
    'of an orange',
  );
  assert.equal(
    card.querySelector('[data-comment-quote]')?.textContent,
    'of an orange',
  );
});

test("a sent comment's arrow opens its thread on the latest preview of its target, once", async () => {
  const window = await open(
    [...answered, preview(9, 1), preview(10, 2)],
    previewProbe,
  );
  const seen = asked(window);

  goTo(window)?.click();
  await settle(20);

  assert.deepEqual(seen, [{ commentId: 'comment-a', target: latestTarget }]);
});

test("a sent comment's arrow on words of the answer reveals their paragraph, and opens no thread", async () => {
  const window = await open(
    commentedAnswer({
      form: 'range',
      text: 'of an orange',
      turn: `agent:${answeredId}:2`,
      block: 0,
    }),
  );
  const seen = asked(window);

  goTo(window)?.click();
  await settle(20);

  const flashed = [
    ...window.document.querySelectorAll('[data-comment-flash]'),
  ].map((element) => element.textContent);
  assert.deepEqual(flashed, [ANSWER]);
  assert.deepEqual(seen, []);
});

test('a sent comment on repeated words marks the occurrence its anchor records', async () => {
  const at = ANSWER.slice(0, ANSWER.lastIndexOf('the')).replace(
    /\s/g,
    '',
  ).length;
  const window = await open(
    commentedAnswer({
      form: 'range',
      text: 'the',
      turn: `agent:${answeredId}:2`,
      block: 0,
      at,
    }),
  );

  const excerpt = line(window)?.querySelector('[data-comment-excerpt]');
  const quote = excerpt?.querySelector('[data-comment-quote]');
  assert.equal(quote?.textContent, 'the');
  assert.equal(quote?.nextSibling?.textContent, ' checkout?');
});

test('Enter and Space on a sent turn’s header and on its arrow are the buttons’, never the prompt’s', async () => {
  const window = await open(
    commentedAnswer({
      form: 'range',
      text: 'of an orange',
      turn: `agent:${answeredId}:2`,
      block: 0,
    }),
  );
  const prompt = window.document.querySelector('[data-prompt-input]');
  assert.ok(prompt);
  const before = prompt.innerHTML;
  const header = groupHeader(window);
  const arrow = goTo(window);
  assert.ok(header && arrow);

  for (const target of [header, arrow]) {
    for (const key of ['Enter', ' ']) {
      target.focus();
      const pressed = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(pressed);
      await settle(20);
      // The editor never answered the key: the browser's own activation of
      // the button (its click) runs, and the prompt stays as it was.
      assert.equal(
        pressed.defaultPrevented,
        false,
        `${key} on ${target.tagName}`,
      );
      assert.equal(prompt.innerHTML, before);
    }
  }
});

/** The flashed elements' text, after a go-to. */
const flashedText = (window: ChatWindow): (string | null)[] =>
  [...window.document.querySelectorAll('[data-comment-flash]')].map(
    (element) => element.textContent,
  );

const LOOSE_LIST = '1. first item\n\n2. second item';

test("a sent comment's arrow on words of a list item reveals that item, not the whole list", async () => {
  const window = await open(
    commentedAnswer(
      {
        form: 'range',
        text: 'second',
        turn: `agent:${answeredId}:2`,
        block: 0,
        item: 1,
      },
      LOOSE_LIST,
    ),
  );

  goTo(window)?.click();
  await settle(20);

  assert.deepEqual(flashedText(window), ['second item']);
});

test('an older sent comment whose anchor names no item reveals its list, as before', async () => {
  const window = await open(
    commentedAnswer(
      {
        form: 'range',
        text: 'second',
        turn: `agent:${answeredId}:2`,
        block: 0,
      },
      LOOSE_LIST,
    ),
  );

  goTo(window)?.click();
  await settle(20);

  assert.equal(flashedText(window).length, 1);
  assert.match(flashedText(window)[0] ?? '', /first item[\s\S]*second item/);
});

test('a sent card says where a press takes the reader: to the passage for words of the answer, to the thread otherwise', async () => {
  const onWords = await open(
    commentedAnswer({
      form: 'range',
      text: 'of an orange',
      turn: `agent:${answeredId}:2`,
      block: 0,
    }),
  );
  assert.equal(
    line(onWords)?.closest('[title]')?.getAttribute('title'),
    'Go to the commented passage',
  );
  await onWords.close();
  opened = undefined;

  const onPreview = await open(
    [...answered, preview(9, 1), preview(10, 2)],
    previewProbe,
  );
  assert.equal(
    line(onPreview)?.closest('[title]')?.getAttribute('title'),
    'Open thread',
  );
});
