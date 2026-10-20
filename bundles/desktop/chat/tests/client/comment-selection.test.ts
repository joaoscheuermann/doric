// The `message` comment gesture as the reader meets it in a window: selecting
// words of an agent's answer no longer floats a `Comment` button over the
// transcript. The selection seats an inline entry after the paragraph it
// starts in; selecting alone inserts nothing, the first typed character puts
// one comment on the composer's stack with the selection quoted on its card,
// Enter commits the note and leaves the comment where it was, Shift+Enter
// writes a newline, and leaving the field throws the draft away.
//
// The composer service here is a fake in the test's `host` answers, standing
// for the desktopMain part the chat bundle ships. The selection itself is built
// with the editor's own APIs (`TextNode.select`), because the window tests have
// no selection helper of their own: a browser's drag is a range the editor
// reads the same way.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  type ClientContext,
  defineMethod,
  defineService,
  ref,
} from 'bundle/contracts';
import {
  $getRoot,
  $isElementNode,
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
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

const thread = () => ({
  id: threadId,
  name: 'Review the parser',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const emptyQueue = { revision: 1, paused: false, stopping: false, items: [] };

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
  createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
});

/** A finished exchange whose answer has one paragraph. */
const exchange = [
  event(1, {
    type: 'prompt.accepted',
    text: 'Where is the parser?',
    source: { kind: 'user' },
  }),
  event(2, {
    type: 'prompt.finished',
    status: 'completed',
    text: 'It lives in src/parser.ts.',
    source: { kind: 'user' },
  }),
];

/** One comment on the fake composer's stack. */
interface StackItem {
  id: string;
  kind: string;
  elementTag: string;
  data: unknown;
  author?: string;
  note: string;
}

/** The composer service the fake host answers with, one Thread's stack. */
interface ComposerFake {
  items: StackItem[];
  streams: OpenStream[];
}

let opened: ChatWindow | undefined;
let composer: ComposerFake | undefined;
/** The editors the window created, as a probe extension sees them. */
const editors = new Set<LexicalEditor>();

afterEach(async () => {
  await opened?.close();
  opened = undefined;
  composer = undefined;
  editors.clear();
});

/** A probe standing in for the layout's `layout.workspace/v1` (the selected
 * Thread), so the composer binds to the Thread the test opens, and collecting
 * every editor the window creates. */
const workspaceProbe = (): Probe => ({
  provides: ['layout.workspace/v1'],
  requires: ['chat.lexical/v1@^1.0.0'],
  activate: ({ services }: ClientContext) => {
    services.use(ChatLexicalV1).registerExtension(
      defineExtension({
        name: 'test/comment-selection',
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
          execute: () => ({ dispose: () => undefined }),
        }),
      }) as never,
    );
  },
});

/** Boots the Thread's conversation with a fake composer service behind it. */
const open = async (): Promise<ChatWindow> => {
  const fake: ComposerFake = { items: [], streams: [] };
  composer = fake;

  opened = await openChatWindow({
    url,
    probe: workspaceProbe(),
    host: {
      'runtime.threads/v1.thread': () => thread(),
      'runtime.threads/v1.queue': () => emptyQueue,
      'comments/v1.add': () => ({
        commentId: 'comment-1',
        target: {
          kind: 'message',
          id: promptId,
          anchor: { form: 'range', text: 'src/parser.ts' },
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
        const item: StackItem = {
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
      'chat.composer/v1.removeItem': (input: unknown) => {
        const removed = input as { id: string };
        fake.items = fake.items.filter((item) => item.id !== removed.id);
        for (const stream of [...fake.streams]) {
          stream.push({ kind: 'removed', threadId, id: removed.id });
        }
        return undefined;
      },
      'chat.composer/v1.flush': () => [],
    },
  });
  await settle(50);

  // The composer's watch streams, as one: the stack store and the editor's
  // draft each hold one, and every delta main pushes reaches both.
  const streams = opened.composerWatches();
  const stream = streams.at(-1);
  assert.equal(stream !== undefined, true, 'the window watches the composer');
  fake.streams.push({
    envelope: (stream as OpenStream).envelope,
    push: (item) => {
      for (const each of streams) each.push(item);
    },
    end: (error) => {
      for (const each of streams) each.end(error);
    },
  } as OpenStream);

  opened.watches().at(-1)?.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events: exchange,
  });
  await settle(200);

  return opened;
};

/** The editor the window shows the conversation in: the one whose blocks
 * include an agent turn. */
const conversationEditor = (): LexicalEditor => {
  const editor = [...editors].find(
    (candidate) =>
      candidate.getRootElement()?.isConnected === true &&
      candidate.getEditorState().read(() =>
        $getRoot()
          .getChildren()
          .some((node) => node.getType() === 'agent-turn-node'),
      ),
  );
  assert.ok(editor, 'the window shows the conversation');
  return editor;
};

/** The editor the window shows the prompt in. */
const promptEditor = (): LexicalEditor => {
  const editor = [...editors].find(
    (candidate) =>
      candidate.getRootElement()?.isConnected === true &&
      candidate.getEditorState().read(() =>
        $getRoot()
          .getChildren()
          .some((node) => node.getType() === 'user-prompt-node'),
      ),
  );
  assert.ok(editor, 'the window shows the prompt');
  return editor;
};

/**
 * Selects `text` inside the agent's answer, the way a drag leaves the editor:
 * a range selection over the run that holds the words. The gesture reads one
 * selection per settle (150ms), so the update is settled after.
 */
const select = async (text: string): Promise<void> => {
  const editor = conversationEditor();
  editor.update(
    () => {
      const turn = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'agent-turn-node');
      assert.ok($isElementNode(turn));
      const run = turn
        .getAllTextNodes()
        .find((node) => node.getTextContent().includes(text));
      assert.ok(run, `the answer holds “${text}”`);
      const start = run.getTextContent().indexOf(text);
      run.select(start, start + text.length);
    },
    { discrete: true },
  );
  await settle(300);
};

/** The inline comment entry the selection seated. */
const seat = (window: ChatWindow): HTMLElement | null =>
  window.document.querySelector('[data-comment-seat]');

/** The entry the seat holds: the field the note is written in. */
const entryOf = (window: ChatWindow): HTMLElement | null =>
  seat(window)?.querySelector('[role="textbox"], [contenteditable="true"]') ??
  null;

/** Writes words into the entry, as the reader's keyboard would. */
const write = async (field: HTMLElement, text: string): Promise<void> => {
  field.focus();
  field.textContent = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(50);
};

/** Presses one key where the focus is, as the reader would. */
const press = async (
  target: Element,
  key: string,
  modifiers: { readonly shiftKey?: boolean } = {},
): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  const view = target.ownerDocument.defaultView as unknown as object;
  Object.defineProperty(view, 'event', { value: event, configurable: true });
  target.dispatchEvent(event);
  Reflect.deleteProperty(view, 'event');
  await settle(50);
  return event;
};

/** The one stack item the fake composer holds. */
const onlyItem = (): StackItem => {
  assert.equal(composer?.items.length, 1, 'one comment on the stack');
  const item = composer?.items[0];
  assert.ok(item);
  return item;
};

test('the paragraph a selection starts in seats the entry after itself, and no Comment button floats over it', async () => {
  const window = await open();
  await select('src/parser.ts');

  // The old floating control is gone: neither its host nor its button.
  assert.equal(
    window.document.querySelectorAll('[data-comment-selection] button').length,
    0,
  );
  assert.equal(
    [...window.document.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Comment',
    ),
    false,
  );

  const seated = seat(window);
  assert.ok(seated, 'the inline seat stands in the transcript');

  const paragraph = [
    ...window.document.querySelectorAll('[data-lexical-editor] p'),
  ].find((element) => element.textContent?.includes('src/parser.ts'));
  assert.ok(paragraph, 'the answer draws the selected words in a paragraph');
  assert.equal(
    paragraph.compareDocumentPosition(seated) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
    'the seat stands after the paragraph that held the selection',
  );
});

test('selecting alone inserts nothing; the first typed character materialises the card with the quote', async () => {
  const window = await open();
  await select('src/parser.ts');

  assert.deepEqual(
    window.received('chat.composer/v1.addItem'),
    [],
    'a selection alone adds no comment',
  );
  const entry = entryOf(window);
  assert.ok(entry, 'the seat holds an entry from the start');
  assert.equal(entry.textContent, '');
  assert.match(
    entry.getAttribute('data-placeholder') ?? '',
    /\S/,
    'the empty entry shows its placeholder',
  );

  await write(entry, 'q');

  const added = window.received('chat.composer/v1.addItem');
  assert.equal(added.length, 1, 'one item, at the first character');
  const item = onlyItem();
  assert.equal(item.note, 'q');
  const data = item.data as {
    seat?: { turn?: unknown; block?: unknown };
    target?: { anchor?: { turn?: unknown; block?: unknown } };
  };
  assert.equal(typeof data.seat?.turn, 'string');
  assert.notEqual(data.seat?.turn, '');
  assert.equal(data.seat?.block, 0, 'the answer’s one block is block 0');
  // The seat and the anchor the send will write name the same place.
  assert.deepEqual(
    { turn: data.seat?.turn, block: data.seat?.block },
    { turn: data.target?.anchor?.turn, block: data.target?.anchor?.block },
    'the stack item names the turn and block of the seat',
  );
  // The card quotes the words the comment is about.
  assert.match(
    window.document.querySelector('[data-composer-stack]')?.textContent ?? '',
    /src\/parser\.ts/,
  );
});

test('Shift+Enter writes a newline and Enter commits, leaving the comment on the stack with the prompt focused', async () => {
  const window = await open();
  await select('src/parser.ts');
  const entry = entryOf(window);
  assert.ok(entry);
  await write(entry, 'line one');

  // Shift+Enter is the browser's own newline: the entry leaves it alone.
  const newline = await press(entry, 'Enter', { shiftKey: true });
  assert.equal(newline.defaultPrevented, false);
  await write(entry, 'line one\nline two');

  const commit = await press(entry, 'Enter');
  assert.equal(commit.defaultPrevented, true);
  await settle(100);

  const item = onlyItem();
  assert.equal(item.note, 'line one\nline two');

  // The entry closes, the prompt takes the caret, and the comment is still a
  // draft: nothing reaches the comments registry before the send.
  assert.equal(entryOf(window), null, 'the entry closed');
  assert.equal(window.document.activeElement, promptEditor().getRootElement());
  assert.deepEqual(window.received('comments/v1.add'), []);
});

test('leaving the field discards the draft: with words the item leaves the stack, empty the entry closes', async () => {
  const window = await open();
  await select('src/parser.ts');
  const entry = entryOf(window);
  assert.ok(entry);
  await write(entry, 'some words');
  assert.equal(onlyItem().note, 'some words');

  entry.blur();
  await settle(100);

  assert.deepEqual(
    window.received('chat.composer/v1.removeItem').map((call) => call.input),
    [{ threadId, id: 'item-1' }],
  );
  assert.equal(composer?.items.length, 0, 'the draft left the stack');
  assert.deepEqual(window.received('comments/v1.add'), []);

  // An entry left empty never added anything, and it closes too.
  await select('It lives');
  const blank = entryOf(window);
  assert.ok(blank);
  assert.equal(window.received('chat.composer/v1.addItem').length, 1);
  blank.blur();
  await settle(100);
  assert.equal(entryOf(window), null, 'the empty entry closed');
  assert.equal(window.received('chat.composer/v1.addItem').length, 1);
});
