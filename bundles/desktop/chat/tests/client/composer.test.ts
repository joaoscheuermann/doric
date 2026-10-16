// The composer's stack above the prompt as the reader meets it in a window:
// one line per comment, with the author's avatar, the note truncated on the
// line and whole in the popover that also edits it, and the anchor with the
// pin's number; the send that a comment alone enables, carrying the stack's
// own Markdown; and the flush that empties the stack into the log only once
// the host accepted the prompt.
//
// The composer service here is a fake in the test's `host` answers, standing
// for the desktopMain part the chat bundle ships; the stack store in the
// window watches it exactly as it watches the real one.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  type ClientContext,
  defineMethod,
  defineService,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

import {
  type ChatWindow,
  type OpenStream,
  openChatWindow,
  type Probe,
  settle,
} from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const path = `/projects/${projectId}/threads/${threadId}`;
const url = `doric://app${path}`;

const thread = () => ({
  id: threadId,
  name: 'Fix the parser',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const emptyQueue = { revision: 1, paused: false, stopping: false, items: [] };

/** The composer service the fake host answers with, one Thread's stack. */
interface ComposerFake {
  items: {
    id: string;
    kind: string;
    elementTag: string;
    data: unknown;
    author?: string;
    note: string;
  }[];
  /** The watch streams the fake answers through, as main would push. */
  streams: OpenStream[];
  /** Adds one item, as the real service's `addItem` does. */
  add(item: ComposerFake['items'][number]): void;
  /** Flushes as the real service does, answering the comment writes. */
  flush(promptId: string): unknown[];
}

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** A probe standing in for the layout's `layout.workspace/v1` (the selected
 * Thread), so the footer composer binds to the Thread the test opens. */
const workspaceProbe = (): Probe => ({
  provides: ['layout.workspace/v1'],
  activate: ({ services }: ClientContext) => {
    const LayoutWorkspaceV1 = ref<{
      thread(id: string): unknown;
      selectedThread(): unknown;
      subscribe(listener: () => void): { dispose(): void };
    }>('layout.workspace/v1');
    services.provide(
      defineService(LayoutWorkspaceV1, {
        thread: defineMethod({
          input: z.string(),
          output: z.unknown(),
          execute: (id: string) => (id === threadId ? thread() : undefined),
        }),
        selectedThread: defineMethod({
          input: z.tuple([]),
          output: z.unknown(),
          execute: () => thread(),
        }),
        subscribe: defineMethod({
          input: z.custom<() => void>((value) => typeof value === 'function'),
          output: z.custom<{ dispose(): void }>(),
          execute: () => ({ dispose: () => undefined }),
        }),
      }) as never,
    );
  },
});

/** Boots a window whose composer service is the fake below. */
const boot = async (extra: Record<string, () => unknown> = {}) => {
  const fake: ComposerFake = {
    items: [],
    streams: [],
    add(item) {
      fake.items.push(item);
      for (const stream of [...fake.streams]) {
        stream.push({ kind: 'added', threadId, item });
      }
    },
    flush(accepted: string) {
      const writes = fake.items.map((item) => ({
        target: (item.data as { target: unknown }).target,
        text: item.note,
        ...(item.author === undefined ? {} : { author: item.author }),
      }));
      for (const item of [...fake.items].reverse()) {
        for (const stream of [...fake.streams]) {
          stream.push({ kind: 'removed', threadId, id: item.id });
        }
      }
      fake.items = [];
      return writes.map((write) => ({ ...write, promptId: accepted }));
    },
  };

  opened = await openChatWindow({
    url,
    probe: workspaceProbe(),
    host: {
      'runtime.threads/v1.thread': () => thread(),
      'runtime.threads/v1.queue': () => emptyQueue,
      'runtime.threads/v1.prompt': () => ({
        status: 'accepted',
        promptId,
      }),
      'comments/v1.add': () => ({
        commentId: 'comment-1',
        target: {
          kind: 'message',
          id: promptId,
          anchor: { form: 'range', text: 'essa resposta' },
        },
        text: 'a note',
        resolved: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      'chat.composer/v1.read': () => ({
        threadId,
        text: '',
        items: fake.items,
      }),
      'chat.composer/v1.setText': () => undefined,
      'chat.composer/v1.addItem': (input: unknown) => {
        const added = input as {
          threadId: string;
          kind: string;
          elementTag: string;
          data?: unknown;
          author?: string;
          note?: string;
        };
        const item = {
          id: `item-${fake.items.length + 1}`,
          kind: added.kind,
          elementTag: added.elementTag,
          data: added.data ?? null,
          ...(added.author === undefined ? {} : { author: added.author }),
          note: added.note ?? '',
        };
        fake.items.push(item);
        for (const stream of [...fake.streams]) {
          stream.push({ kind: 'added', threadId: added.threadId, item });
        }
        return item;
      },
      'chat.composer/v1.updateNote': () => undefined,
      'chat.composer/v1.removeItem': () => undefined,
      'chat.composer/v1.flush': (input: unknown) =>
        fake.flush((input as { promptId: string }).promptId),
      ...extra,
    },
  });
  await settle(50);

  return { window: opened, composer: fake };
};
/** The composer watch stream the stack store holds. */
const composerWatch = (window: ChatWindow): OpenStream => {
  const stream = window.composerWatches().at(-1);
  assert.equal(stream !== undefined, true, 'the window watches the composer');

  return stream as OpenStream;
};

const footer = async (window: ChatWindow): Promise<Element> => {
  const region = window.document.createElement('core-region');
  region.setAttribute('name', 'layout.footer');
  window.document.body.append(region);
  await settle(50);

  return region as unknown as Element;
};

const button = (root: Element, label: string): HTMLButtonElement | null =>
  root.querySelector(`button[aria-label="${label}"]`);

test('the stack draws one line per comment, with the author, the note and the anchored pin', async () => {
  const { window, composer: fake } = await boot();
  const watch = composerWatch(window);
  fake.streams.push(watch);

  fake.add({
    id: 'item-1',
    kind: 'message',
    elementTag: 'chat-comment-line',
    data: {
      target: {
        kind: 'message',
        id: promptId,
        anchor: { form: 'range', text: 'essa resposta' },
      },
    },
    author: 'jao.scheuermann',
    note: 'essa resposta está desatualizada',
  });
  await settle(50);

  const stack = window.document.querySelector('[data-composer-stack]');
  assert.equal(stack !== null, true, 'the stack stands above the prompt');
  const line = stack?.querySelector('button[aria-label^="Comment 1"]');
  assert.equal(line !== null, true, 'one line per comment');
  // The line carries the reader's avatar, their name, the note truncated
  // with an ellipsis (the `truncate` utility) and the anchor with the pin.
  assert.match(line?.textContent ?? '', /jao\.scheuermann/);
  assert.match(line?.textContent ?? '', /essa resposta está desatualizada/);
  assert.match(
    line?.getAttribute('aria-label') ?? '',
    /Comment 1 on “essa resposta”/,
  );
  assert.equal(line?.querySelector('.truncate') !== null, true);
});

test('opening a line shows the note whole and edits it where it was written', async () => {
  const { window, composer: fake } = await boot();
  const watch = composerWatch(window);
  fake.streams.push(watch);

  const note = 'aumenta o respiro do botão, que está apertado demais';
  fake.add({
    id: 'item-1',
    kind: 'message',
    elementTag: 'chat-comment-line',
    data: {
      target: {
        kind: 'message',
        id: promptId,
        anchor: { form: 'range', text: 'o botão' },
      },
    },
    author: 'jao.scheuermann',
    note,
  });
  await settle(50);

  const line = window.document.querySelector(
    'button[aria-label^="Comment 1"]',
  ) as HTMLButtonElement | null;
  assert.equal(line !== null, true);
  line?.click();
  await settle(50);

  // Radix's popover content is portalled to the document body, away from the
  // stack it belongs to.
  const area = window.document.querySelector(
    'textarea',
  ) as HTMLTextAreaElement | null;
  assert.equal(area !== null, true, 'the note is written in the popover');
  assert.equal(area?.value, note);

  area?.focus();
  area?.setAttribute('value', 'uma nota menor');
  area?.dispatchEvent(
    new (area.ownerDocument.defaultView ?? globalThis).Event('input', {
      bubbles: true,
    }) as unknown as Event,
  );
  await settle(50);
  assert.equal(
    window.document.querySelector('textarea')?.getAttribute('value'),
    'uma nota menor',
  );
});

test('a comment alone is something to send: the send carries the stack', async () => {
  const { window, composer: fake } = await boot();
  const watch = composerWatch(window);
  fake.streams.push(watch);

  fake.add({
    id: 'item-1',
    kind: 'message',
    elementTag: 'chat-comment-line',
    data: {
      target: {
        kind: 'message',
        id: promptId,
        anchor: { form: 'range', text: 'essa resposta' },
      },
    },
    author: 'jao.scheuermann',
    note: 'essa resposta está desatualizada',
  });
  await settle(50);

  const region = await footer(window);
  const send = button(region, 'Send (Cmd+Enter)');
  // The editor holds no words, but the stack holds a line: the send is live.
  assert.equal(send !== null, true);
  assert.equal(send?.disabled, false);

  send?.click();
  await settle(150);

  // The prompt that went out is the stack's own Markdown, one line per
  // comment with its anchor.
  const sent = window
    .received('runtime.threads/v1.prompt')
    .map((call) => call.input);
  assert.deepEqual(sent, [
    {
      id: threadId,
      prompt: '- essa resposta está desatualizada — “essa resposta”',
    },
  ]);

  // The flush ran once the host accepted, and the sender performed the
  // comment writes it answered, in the scope of the accepted prompt.
  const flushed = window
    .received('chat.composer/v1.flush')
    .map((call) => call.input);
  assert.deepEqual(flushed, [{ threadId, promptId }]);
  const written = window.received('comments/v1.add').map((call) => call.scope);
  assert.equal(written.length, 1);
  assert.equal(written[0]?.projectId, projectId);
  assert.equal(written[0]?.threadId, threadId);
  assert.equal(written[0]?.promptId, promptId);

  // The stack emptied with the acceptance, and the window drew it so.
  await settle(50);
  assert.equal(
    window.document.querySelector('button[aria-label^="Comment 1"]'),
    null,
  );
});

test('a send the host refuses restores the words and keeps the stack where it was', async () => {
  const { window, composer: fake } = await boot({
    'runtime.threads/v1.prompt': () => {
      throw new Error('The thread cannot perform this operation.');
    },
  });
  const watch = composerWatch(window);
  fake.streams.push(watch);

  fake.add({
    id: 'item-1',
    kind: 'message',
    elementTag: 'chat-comment-line',
    data: {
      target: {
        kind: 'message',
        id: promptId,
        anchor: { form: 'range', text: 'essa resposta' },
      },
    },
    author: 'jao.scheuermann',
    note: 'essa resposta está desatualizada',
  });
  await settle(50);

  const region = await footer(window);
  button(region, 'Send (Cmd+Enter)')?.click();
  await settle(150);

  // The refusal restored the stack's own words to the editor — the ones the
  // send went out with — and the stack itself kept every item.
  assert.equal(
    window.document.querySelector('button[aria-label^="Comment 1"]') !== null,
    true,
  );
  const flushed = window.received('chat.composer/v1.flush');
  assert.equal(flushed.length, 0, 'a refused send never flushes');
  const written = window.received('comments/v1.add');
  assert.equal(written.length, 0, 'a refused send writes no comment');
});
