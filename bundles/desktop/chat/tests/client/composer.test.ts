// The composer's stack above the prompt as the reader meets it in a window:
// one line per comment, with the author's avatar, the note — written in place,
// in the line — and the anchor with the pin's number; the keys that walk the
// caret between the notes and the prompt and remove a comment; the send that
// a comment alone enables, carrying the prompt envelope; and the flush that
// empties the stack into the log only once the host accepted the prompt.
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
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import { z } from 'zod';

import { ChatLexicalV1 } from '../../src/contracts/index.js';
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
/** The prompt the Thread runs while `threadState` is `running`. */
const activePromptId = '55555555-5555-4555-8555-555555555555';
const path = `/projects/${projectId}/threads/${threadId}`;
const url = `doric://app${path}`;

/** The Thread's state as the workspace reports it; a send moves it on. */
let threadState = 'idle';
/** Who watches the workspace, told when the Thread's record changes. */
const workspaceListeners = new Set<() => void>();

const thread = () => ({
  id: threadId,
  name: 'Fix the parser',
  projectId,
  state: threadState,
  ...(threadState === 'running' ? { activePromptId } : {}),
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
  /** Flushes as the real service does, answering each item with its writes. */
  flush(promptId: string): unknown[];
}

let opened: ChatWindow | undefined;
/** The prompt editors the window created, as a probe extension sees them. */
const editors = new Set<LexicalEditor>();

afterEach(async () => {
  await opened?.close();
  opened = undefined;
  editors.clear();
  threadState = 'idle';
  workspaceListeners.clear();
});

/** A probe standing in for the layout's `layout.workspace/v1` (the selected
 * Thread), so the footer composer binds to the Thread the test opens. */
const workspaceProbe = (): Probe => ({
  provides: ['layout.workspace/v1'],
  requires: ['chat.lexical/v1@^1.0.0'],
  activate: ({ services }: ClientContext) => {
    services.use(ChatLexicalV1).registerExtension(
      defineExtension({
        name: 'test/composer-input',
        register: (editor) => {
          editors.add(editor);
          return () => {
            editors.delete(editor);
          };
        },
      }),
    );
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
          execute: (listener: () => void) => {
            workspaceListeners.add(listener);
            return { dispose: () => workspaceListeners.delete(listener) };
          },
        }),
      }) as never,
    );
  },
});

/** Boots a window whose composer service is the fake below. */
const boot = async (
  extra: Record<string, (input: unknown) => unknown> = {},
) => {
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
      const flushed = fake.items.map((item) => ({
        item,
        writes: [
          {
            target: (item.data as { target: unknown }).target,
            text: item.note,
            ...(item.author === undefined ? {} : { author: item.author }),
            promptId: accepted,
          },
        ],
      }));
      for (const item of [...fake.items].reverse()) {
        for (const stream of [...fake.streams]) {
          stream.push({ kind: 'removed', threadId, id: item.id });
        }
      }
      fake.items = [];
      return flushed;
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
/**
 * The composer's watch streams, as one: the stack store and the editor's draft
 * each hold one, and every delta main pushes reaches both.
 */
const composerWatch = (window: ChatWindow): OpenStream => {
  const streams = window.composerWatches();
  const stream = streams.at(-1);
  assert.equal(stream !== undefined, true, 'the window watches the composer');

  return {
    envelope: (stream as OpenStream).envelope,
    push: (item) => {
      for (const each of streams) each.push(item);
    },
    end: (error) => {
      for (const each of streams) each.end(error);
    },
  };
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

/**
 * Writes the reader's words into the conversation's prompt: the editor the
 * window shows (the footer only holds the send control that reaches it).
 */
const type = async (text: string): Promise<void> => {
  const editor = [...editors].find(
    (candidate) => candidate.getRootElement()?.isConnected === true,
  );
  assert.ok(editor, 'the window shows a prompt editor');
  editor.update(() => {
    const prompt = $getRoot()
      .getChildren()
      .find((node) => node.getType() === 'user-prompt-node');
    assert.ok($isElementNode(prompt));
    prompt.clear().append($createTextNode(text));
  });
  await settle();
};

/** One `message` comment, as the conversation's selection adds it. */
const messageComment = (note: string) => ({
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
  note,
});

/** The note of the stack line with this pin, as the reader writes in it. */
const noteOf = (window: ChatWindow, pin: number): HTMLElement | null =>
  window.document.querySelector(
    `[role="textbox"][aria-label^="Comment ${pin} "], [role="textbox"][aria-label="Comment ${pin}"]`,
  );

/** The editor the window shows the conversation in. */
const shownEditor = (): LexicalEditor => {
  const editor = [...editors].find(
    (candidate) => candidate.getRootElement()?.isConnected === true,
  );
  assert.ok(editor, 'the window shows a prompt editor');
  return editor;
};

/** Presses one key where the focus is, as the reader would. */
const press = async (
  target: Element,
  key: string,
  modifiers: {
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
  } = {},
): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  // A browser names the event it is dispatching as `window.event`, which the
  // editor reads to keep its own caret through a key; happy-dom does not.
  const view = target.ownerDocument.defaultView as unknown as object;
  Object.defineProperty(view, 'event', { value: event, configurable: true });
  target.dispatchEvent(event);
  Reflect.deleteProperty(view, 'event');
  await settle(20);
  return event;
};

/**
 * The window's send chord, `CmdOrCtrl+Enter`: Ctrl here, because happy-dom
 * does not report a macOS platform.
 */
const sendChord = { ctrlKey: true } as const;

/** Where the editor's caret stands: its block's type, and its offset there. */
const caretIn = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return undefined;
    const node = selection.anchor.getNode();
    const block = node.getTopLevelElement() ?? node;
    return {
      block: block.getType(),
      atStart: selection.anchor.offset === 0,
    };
  });

/** Boots a window with these items on the stack. */
const stacked = async (...notes: string[]) => {
  const booted = await boot();
  booted.composer.streams.push(composerWatch(booted.window));
  for (const [index, note] of notes.entries()) {
    booted.composer.add({ ...messageComment(note), id: `item-${index + 1}` });
  }
  await settle(50);
  return booted;
};

test('the stack draws one line per comment, with the avatar, the author, the note and the anchored pin', async () => {
  const { window } = await stacked('essa resposta está desatualizada');

  const stack = window.document.querySelector('[data-composer-stack]');
  assert.equal(stack !== null, true, 'the stack stands above the prompt');
  const note = noteOf(window, 1);
  assert.equal(note !== null, true, 'one line per comment');
  assert.equal(note?.textContent, 'essa resposta está desatualizada');
  assert.equal(
    note?.getAttribute('aria-label'),
    'Comment 1 on “essa resposta”',
  );
  // The avatar comes before the author's name and reads as the initials of it,
  // and the note truncates with an ellipsis (the `truncate` utility) while it is
  // not being written.
  const line = note?.parentElement;
  assert.match(line?.textContent ?? '', /jao\.scheuermann/);
  assert.match(line?.textContent ?? '', /\[1\]/);
  const avatar = line?.firstElementChild;
  const name = [...(line?.children ?? [])].find((child) =>
    child.textContent?.includes('jao.scheuermann'),
  );
  assert.ok(avatar && name);
  assert.equal(avatar.tagName, 'SPAN', 'the avatar is a span, not an image');
  assert.equal(avatar.textContent, 'JS', 'and reads as the initials');
  assert.equal(
    avatar.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(note?.classList.contains('truncate'), true);
});

test('a note is written in place, and every edit goes to the composer', async () => {
  const { window } = await stacked('aumenta o respiro do botão');

  const note = noteOf(window, 1);
  assert.ok(note);
  // No popover and no field of its own: the line's note is the editor.
  assert.equal(note.getAttribute('contenteditable'), 'true');
  note.focus();
  note.textContent = 'uma nota menor';
  note.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(50);

  const written = window
    .received('chat.composer/v1.updateNote')
    .map((call) => call.input);
  assert.deepEqual(written.at(-1), {
    threadId,
    id: 'item-1',
    note: 'uma nota menor',
  });
  // The note keeps the caret and the words while the edit travels.
  assert.equal(window.document.activeElement, note);
  assert.equal(note.textContent, 'uma nota menor');
});

test("a note's placeholder shows only while the note holds no text, following what the reader writes", async () => {
  const { window } = await stacked('texto zoado', '');

  // The placeholder rule draws a host that carries `data-placeholder`.
  const written = noteOf(window, 1);
  const empty = noteOf(window, 2);
  assert.ok(written && empty);
  assert.equal(written.hasAttribute('data-placeholder'), false);
  assert.equal(empty.getAttribute('data-placeholder'), 'Write a note…');

  written.focus();
  written.textContent = '';
  written.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(50);
  assert.equal(written.getAttribute('data-placeholder'), 'Write a note…');

  written.textContent = 'de novo';
  written.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(50);
  assert.equal(written.hasAttribute('data-placeholder'), false);
});

test('the stack is a list named for screen readers, with no heading above it', async () => {
  const { window } = await stacked('uma nota');

  const stack = window.document.querySelector('section[aria-label]');
  assert.ok(stack?.querySelector('[data-composer-stack-list]'));
  assert.equal(stack?.getAttribute('aria-label'), 'Comments to send');
  assert.equal(stack?.querySelector('h1, h2, h3'), null);
});

test('Cmd+Backspace removes the comment and leaves the caret at the end of the note before', async () => {
  const { window } = await stacked('primeira', 'segunda');

  const second = noteOf(window, 2);
  assert.ok(second);
  second.focus();
  const event = await press(second, 'Backspace', { metaKey: true });
  await settle(50);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(
    window.received('chat.composer/v1.removeItem').map((call) => call.input),
    [{ threadId, id: 'item-2' }],
  );
  assert.equal(noteOf(window, 2), null, 'the line left the stack');
  assert.equal(window.document.activeElement, noteOf(window, 1));
});

test('Backspace in an empty note removes it, and the last one hands the caret to the prompt', async () => {
  const { window } = await stacked('');

  const note = noteOf(window, 1);
  assert.ok(note);
  note.focus();
  await press(note, 'Backspace');
  await settle(50);

  assert.deepEqual(
    window.received('chat.composer/v1.removeItem').map((call) => call.input),
    [{ threadId, id: 'item-1' }],
  );
  const editor = shownEditor();
  assert.equal(window.document.activeElement, editor.getRootElement());
  assert.deepEqual(caretIn(editor), {
    block: 'user-prompt-node',
    atStart: true,
  });
});

test("ArrowUp on the prompt's first line puts the caret at the end of the last note", async () => {
  const { window } = await stacked('primeira', 'segunda');

  await type('Ajusta isso');
  const editor = shownEditor();
  const root = editor.getRootElement();
  assert.ok(root);
  root.focus();
  // The caret at the end of the prompt's one line as the key arrives.
  editor.update(
    () => {
      const prompt = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'user-prompt-node');
      assert.ok($isElementNode(prompt));
      prompt.selectEnd();
    },
    { discrete: true },
  );
  const event = await press(root, 'ArrowUp');

  assert.equal(event.defaultPrevented, true);
  const last = noteOf(window, 2);
  assert.equal(window.document.activeElement, last);
  assert.equal(
    window.document.getSelection()?.anchorNode?.textContent,
    'segunda',
  );
});

test('Enter moves on to the next note, and from the last one to the end of the prompt', async () => {
  const { window } = await stacked('primeira', 'segunda');

  const first = noteOf(window, 1);
  assert.ok(first);
  first.focus();
  await press(first, 'Enter');
  assert.equal(window.document.activeElement, noteOf(window, 2));

  const second = noteOf(window, 2);
  assert.ok(second);
  await press(second, 'Enter');
  await settle(20);
  const editor = shownEditor();
  assert.equal(window.document.activeElement, editor.getRootElement());
  assert.equal(caretIn(editor)?.block, 'user-prompt-node');
  // The note never took the key as a line of its own.
  assert.equal(second.textContent, 'segunda');
});

test('Cmd+Enter in a note sends the stack with the note as written', async () => {
  const { window } = await stacked('antes');

  const note = noteOf(window, 1);
  assert.ok(note);
  note.focus();
  note.textContent = 'depois';
  note.dispatchEvent(new Event('input', { bubbles: true }));
  await press(note, 'Enter', sendChord);
  await settle(150);

  const sent = window
    .received('runtime.threads/v1.prompt')
    .map((call) => (call.input as { prompt: string }).prompt);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? '', /<comment id="item-1"[^>]*>depois<\/comment>/);
});

test("Cmd+Enter is the window's: away from the prompt, a comment alone goes out once", async () => {
  const { window, composer: fake } = await boot();
  fake.streams.push(composerWatch(window));
  fake.add(messageComment('essa resposta está desatualizada'));
  await settle(50);

  await press(window.document.body, 'Enter', sendChord);
  await settle(150);

  const sent = window
    .received('runtime.threads/v1.prompt')
    .map((call) => call.input as { id: string; prompt: string });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.id, threadId);
  assert.match(
    sent[0]?.prompt ?? '',
    /<comment id="item-1"[^>]*>essa resposta está desatualizada<\/comment>/,
  );
  assert.doesNotMatch(sent[0]?.prompt ?? '', /<message>/);
});

test('a note a surface confirms when the send asks goes out with it', async () => {
  const { window, composer: fake } = await boot();
  const asked: string[] = [];
  // A surface holding an unconfirmed note (a Papercraft input): it confirms
  // the note when the send asks, and the service's echo has not arrived yet.
  window.document.addEventListener('doric:prompt-send', (event) => {
    const detail = (event as CustomEvent).detail as {
      threadId: string;
      waitUntil(pending: Promise<unknown>): void;
    };
    asked.push(detail.threadId);
    detail.waitUntil(
      new Promise<void>((done) => {
        setTimeout(() => {
          fake.items.push(messageComment('confirmada agora'));
          done();
        }, 30);
      }),
    );
  });

  await press(window.document.body, 'Enter', sendChord);
  await settle(150);

  assert.deepEqual(asked, [threadId]);
  const sent = window
    .received('runtime.threads/v1.prompt')
    .map((call) => (call.input as { prompt: string }).prompt);
  assert.equal(sent.length, 1);
  assert.match(
    sent[0] ?? '',
    /<comment id="item-1"[^>]*>confirmada agora<\/comment>/,
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

  // The prompt that went out is the envelope of the stack alone: the
  // comment under its target, with its anchor, and no message.
  const sent = window
    .received('runtime.threads/v1.prompt')
    .map((call) => call.input);
  assert.deepEqual(sent, [
    {
      id: threadId,
      prompt: [
        '<comments>',
        `<target kind="message" id="${promptId}">`,
        '<comment id="item-1" anchor="range" quote="essa resposta">essa resposta está desatualizada</comment>',
        '</target>',
        '</comments>',
      ].join('\n'),
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
  assert.equal(noteOf(window, 1), null);
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
  assert.equal(noteOf(window, 1) !== null, true);
  const flushed = window.received('chat.composer/v1.flush');
  assert.equal(flushed.length, 0, 'a refused send never flushes');
  const written = window.received('comments/v1.add');
  assert.equal(written.length, 0, 'a refused send writes no comment');
});

test('a send with words carries the stack’s anchors in the prompt too', async () => {
  const { window, composer: fake } = await boot();
  const watch = composerWatch(window);
  fake.streams.push(watch);

  fake.add(messageComment('essa resposta está desatualizada'));
  await settle(50);

  const region = await footer(window);
  await type('Atualiza a resposta, por favor');
  button(region, 'Send (Cmd+Enter)')?.click();
  await settle(150);

  // The agent reads only the prompt: the comment and its anchor travel in
  // it, above the reader's own words.
  assert.deepEqual(
    window.received('runtime.threads/v1.prompt').map((call) => call.input),
    [
      {
        id: threadId,
        prompt: [
          '<comments>',
          `<target kind="message" id="${promptId}">`,
          '<comment id="item-1" anchor="range" quote="essa resposta">essa resposta está desatualizada</comment>',
          '</target>',
          '</comments>',
          '<message>',
          'Atualiza a resposta, por favor',
          '</message>',
        ].join('\n'),
      },
    ],
  );
  assert.equal(window.received('comments/v1.add').length, 1);
});

test('a flushed comment whose write fails goes back on the stack', async () => {
  const { window, composer: fake } = await boot({
    'comments/v1.add': () => {
      throw new Error('The store is unreachable.');
    },
  });
  const watch = composerWatch(window);
  fake.streams.push(watch);

  fake.add(messageComment('essa resposta está desatualizada'));
  await settle(50);

  const region = await footer(window);
  button(region, 'Send (Cmd+Enter)')?.click();
  await settle(150);

  // The prompt went out and the flush ran, but the log never received the
  // comment: the sender put the item back, with its note and its target.
  assert.equal(window.received('chat.composer/v1.flush').length, 1);
  const restored = window
    .received('chat.composer/v1.addItem')
    .map((call) => call.input as Record<string, unknown>);
  assert.equal(restored.length, 1);
  // It comes back under the comment id it was sent with.
  assert.equal(restored[0]?.id, 'item-1');
  assert.equal(restored[0]?.kind, 'message');
  assert.equal(restored[0]?.note, 'essa resposta está desatualizada');
  assert.deepEqual(
    restored[0]?.data,
    messageComment('essa resposta está desatualizada').data,
  );

  await settle(50);
  assert.equal(noteOf(window, 1) !== null, true, 'the line is drawn again');
});

test('a sent prompt leaves the editor empty even when the Thread moves on', async () => {
  // The composer service holds the words the reader typed, as the real one
  // does once the editor settles.
  let saved = '';
  const { window } = await boot({
    'chat.composer/v1.read': () => ({ threadId, text: saved, items: [] }),
    'chat.composer/v1.setText': (input: unknown) => {
      saved = (input as { text: string }).text;
    },
  });

  const region = await footer(window);
  await type('Carrega o componente com o papercraft');
  await settle(400);
  assert.equal(saved, 'Carrega o componente com o papercraft');

  button(region, 'Send (Cmd+Enter)')?.click();
  // The host accepted the prompt and the Thread starts running: the workspace
  // reports a new record before the editor's next write settles.
  threadState = 'running';
  for (const listener of [...workspaceListeners]) listener();
  await settle(500);

  const editor = [...editors].find(
    (candidate) => candidate.getRootElement()?.isConnected === true,
  );
  assert.ok(editor);
  const words = editor.getEditorState().read(
    () =>
      $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'user-prompt-node')
        ?.getTextContent()
        .trim() ?? '',
  );
  assert.equal(words, '', 'the sent words left the prompt');
  assert.equal(saved, '', 'the service forgot the sent words');
});

test('a send made elsewhere clears the draft, and the editor empties with it', async () => {
  let saved = '';
  const { window } = await boot({
    'chat.composer/v1.read': () => ({ threadId, text: saved, items: [] }),
    'chat.composer/v1.setText': (input: unknown) => {
      saved = (input as { text: string }).text;
    },
  });

  await footer(window);
  await type('Ajusta o espaçamento');
  await settle(400);
  assert.equal(saved, 'Ajusta o espaçamento');

  // `chat.send/v1`, from the papercraft window, took the words and cleared
  // the draft on the service: every watch sees the empty text.
  composerWatch(window).push({ kind: 'text', threadId, text: '' });
  await settle(50);

  const editor = [...editors].find(
    (candidate) => candidate.getRootElement()?.isConnected === true,
  );
  assert.ok(editor);
  const words = editor.getEditorState().read(
    () =>
      $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'user-prompt-node')
        ?.getTextContent()
        .trim() ?? '',
  );
  assert.equal(words, '');
});

/** The words of the conversation's prompt block, as the reader sees them. */
const promptWords = (): string =>
  shownEditor()
    .getEditorState()
    .read(
      () =>
        $getRoot()
          .getChildren()
          .find((node) => node.getType() === 'user-prompt-node')
          ?.getTextContent()
          .trim() ?? '',
    );

/** Boots a window over a running Thread that answers steers and stops. */
const running = async () => {
  threadState = 'running';
  const booted = await boot({
    'runtime.threads/v1.steer': () => ({ status: 'steered', promptId }),
    'runtime.threads/v1.pause': () => 'interrupted',
  });
  const root = shownEditor().getRootElement();
  assert.ok(root);
  return { window: booted.window, root };
};

test('while a prompt runs, Cmd+Enter steers it with the words at its next safe point', async () => {
  const { window, root } = await running();

  await type('Use the cache instead');
  await press(root, 'Enter', sendChord);
  await settle(100);

  const steers = window
    .received('runtime.threads/v1.steer')
    .map((call) => call.input as Record<string, unknown>);
  assert.equal(steers.length, 1);
  assert.equal(steers[0]?.promptId, activePromptId);
  assert.equal(steers[0]?.interrupt, undefined);
  assert.match(String(steers[0]?.prompt), /Use the cache instead/);
  assert.equal(window.received('runtime.threads/v1.prompt').length, 0);
  assert.equal(promptWords(), '');
});

test('while a prompt runs, Tab queues the words for after it', async () => {
  const { window, root } = await running();

  await type('Then update the docs');
  const event = await press(root, 'Tab');
  await settle(100);

  assert.equal(event.defaultPrevented, true);
  assert.equal(window.received('runtime.threads/v1.prompt').length, 1);
  assert.match(
    String(
      (
        window.received('runtime.threads/v1.prompt')[0]?.input as
          | { prompt: string }
          | undefined
      )?.prompt,
    ),
    /Then update the docs/,
  );
  assert.equal(window.received('runtime.threads/v1.steer').length, 0);
});

test('while a prompt runs, Escape with words aborts its step and steers it', async () => {
  const { window, root } = await running();

  await type('Stop, wrong file');
  await press(root, 'Escape');
  await settle(100);

  const steers = window
    .received('runtime.threads/v1.steer')
    .map((call) => call.input as Record<string, unknown>);
  assert.deepEqual(
    steers.map(({ promptId: target, interrupt }) => ({ target, interrupt })),
    [{ target: activePromptId, interrupt: true }],
  );
  assert.equal(window.received('runtime.threads/v1.pause').length, 0);
});

test('while a prompt runs, Escape without words and Ctrl+C with nothing selected stop it', async () => {
  const { window, root } = await running();

  await press(root, 'Escape');
  await press(root, 'c', { ctrlKey: true });
  await settle(100);

  assert.deepEqual(
    window.received('runtime.threads/v1.pause').map((call) => call.input),
    [
      { id: threadId, promptId: activePromptId },
      { id: threadId, promptId: activePromptId },
    ],
  );
  assert.equal(window.received('runtime.threads/v1.steer').length, 0);
});
