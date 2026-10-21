// The `message` comment gesture as the reader meets it in a window. Selecting
// words of an agent's answer draws nothing new; typing over them opens a new
// comment holding what was typed, at the end of the innermost block that holds
// the end of the words (after a paragraph, or at the end of a list item), and
// the words stay highlighted while the comment stands. The comment is one
// element — the reader's avatar and the note, written and edited in place, with
// no quote and no author name — and the stack inside the prompt lists it too.
// Its first words put one item on the composer's stack under the comment's own
// id; Enter commits and hands the caret to the prompt, Shift+Enter writes a
// newline; Escape, and Backspace on an empty note, remove the comment; leaving
// it keeps a written comment and removes an empty one; every typing gesture
// opens a new comment, several to a paragraph in passage order; the passage
// under the pointer shows it can be clicked, and a click on it puts the caret
// back in its comment. The comments outlive the conversation's mount and an
// undo, and stand still while the answer streams on.
//
// The composer service here is a fake in the test's `host` answers, standing
// for the desktopMain part the chat bundle ships; like it, it keeps an id with
// the `comment-` prefix that the caller chose. The selection itself is built
// with the editor's own APIs (`TextNode.select`), because the window tests have
// no selection helper of their own: a browser's drag is a range the editor
// reads the same way. happy-dom has no CSS Custom Highlight API and lays
// nothing out, so the window gets a registry standing for the platform's
// (`installHighlights`), read back by the test, and a caret-from-point that
// names a text position (`pointAt`).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  type ClientContext,
  defineMethod,
  defineService,
  ref,
} from 'bundle/contracts';
import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  COMPOSITION_START_COMMAND,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  defineExtension,
  type ElementNode,
  HISTORIC_TAG,
  type LexicalEditor,
  UNDO_COMMAND,
} from 'lexical';
import { z } from 'zod';

import { ChatLexicalV1, READER_NAME } from '../../src/contracts/index.js';
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

/** A finished exchange whose answer has two paragraphs, the second holding
 * the same words twice. */
const twoParagraphs = [
  exchange[0],
  event(2, {
    type: 'prompt.finished',
    status: 'completed',
    text: 'The parser moved.\n\nRead src/parser.ts, then src/parser.ts again.',
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
  /** How long an add takes to answer, so a test can keep one out. */
  addDelay: number;
  /** How many items the fake has made, for the next id. */
  made: number;
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
const open = async (
  events = exchange,
  stacked: readonly StackItem[] = [],
): Promise<ChatWindow> => {
  const fake: ComposerFake = {
    items: [...stacked],
    streams: [],
    addDelay: 0,
    made: stacked.length,
  };
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
      'chat.composer/v1.addItem': async (input: unknown) => {
        if (fake.addDelay > 0) {
          await new Promise((done) => setTimeout(done, fake.addDelay));
        }
        const added = input as {
          threadId: string;
          id?: string;
          kind: string;
          elementTag: string;
          data?: unknown;
          author?: string;
          note?: string;
        };
        fake.made += 1;
        // The composer keeps a `comment-` id its caller chose, as main does.
        const kept =
          added.id?.startsWith('comment-') === true &&
          !fake.items.some((item) => item.id === added.id);
        const item: StackItem = {
          id: kept ? (added.id as string) : `item-${fake.made}`,
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
  // Main's watch opens on the stack it holds.
  if (stacked.length > 0) {
    for (const each of streams) {
      each.push({ kind: 'snapshot', threadId, text: '', items: [...stacked] });
    }
  }

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
 * a range selection over the run that holds the words — its `nth` occurrence
 * there, dragged backwards when asked. The update is settled after.
 */
const select = async (
  text: string,
  how: { readonly backwards?: boolean; readonly nth?: number } = {},
): Promise<void> => {
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
      let start = run.getTextContent().indexOf(text);
      for (let skipped = 0; skipped < (how.nth ?? 0); skipped += 1) {
        start = run.getTextContent().indexOf(text, start + 1);
      }
      if (how.backwards === true) run.select(start + text.length, start);
      else run.select(start, start + text.length);
    },
    { discrete: true },
  );
  await settle(50);
};

/** The editor's root: the transcript and the prompt's one editing host. */
const rootOf = (): HTMLElement => {
  const root = conversationEditor().getRootElement();
  assert.ok(root);
  return root;
};

/** Presses one key on the transcript's own text, as the reader's keyboard does. */
const keyOnTranscript = (
  key: string,
  modifiers: KeyboardEventInit = {},
): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  rootOf().dispatchEvent(event);
  return event;
};

/**
 * Opens a comment the way the reader does: selects the words, then types one
 * character over them. Answers the keystroke.
 */
const opening = async (
  words: string,
  how: { readonly backwards?: boolean; readonly nth?: number } = {},
  typed = 'x',
): Promise<KeyboardEvent> => {
  await select(words, how);
  const event = keyOnTranscript(typed);
  await settle(100);
  return event;
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

/** The registry standing for the platform's `CSS.highlights`, by name. */
type Highlights = Map<string, Set<Range>>;

/**
 * Gives the window the CSS Custom Highlight API happy-dom lacks: a `Highlight`
 * that is a set of ranges, and `CSS.highlights`, a registry of them by name.
 */
const installHighlights = (window: ChatWindow): Highlights => {
  const registry: Highlights = new Map();
  const view = window.window as unknown as Record<string, unknown>;
  Object.defineProperty(view, 'Highlight', {
    configurable: true,
    value: class extends Set<Range> {},
  });
  // happy-dom draws a new `CSS` on every read, so the window's own is replaced
  // by one that keeps the original's members and adds the registry.
  Object.defineProperty(view, 'CSS', {
    configurable: true,
    value: Object.create((view.CSS ?? null) as object | null, {
      highlights: { value: registry },
    }),
  });
  return registry;
};

/** The words the transcript keeps highlighted for comments. */
const highlighted = (registry: Highlights): string[] =>
  [...(registry.get('chat-comment') ?? [])].map((range) => range.toString());

/** The answer's text run that holds `words`, as the window draws it. */
const drawnRun = (window: ChatWindow, words: string): Text => {
  const paragraph = [
    ...window.document.querySelectorAll('[data-lexical-editor] p'),
  ].find((element) => element.textContent?.includes(words));
  assert.ok(paragraph, `the answer draws “${words}”`);
  const walker = window.document.createTreeWalker(paragraph, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node as Text).data.includes(words)) return node as Text;
  }
  assert.fail(`no text run holds “${words}”`);
};

/** Clicks the answer's words with the caret left inside them, `into` along. */
const click = async (
  window: ChatWindow,
  words: string,
  into: number,
): Promise<void> => {
  const run = drawnRun(window, words);
  window.document.getSelection()?.collapse(run, run.data.indexOf(words) + into);
  run.parentElement?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
  );
  await settle(50);
};

/** The stack's comment group inside the prompt, if it draws one. */
const stackSection = (window: ChatWindow): Element | null =>
  window.document.querySelector('section[aria-label="Comments to send"]');

/** Every inline comment's note, in the order the transcript draws them. */
const entries = (window: ChatWindow): HTMLElement[] => [
  ...window.document.querySelectorAll<HTMLElement>(
    '[data-comment-seat] [role="textbox"]',
  ),
];

/**
 * Types one character over the current selection, writes `note` in the
 * comment it opens and commits it, the caret back in the prompt.
 */
const typeComment = async (note: string): Promise<HTMLElement> => {
  keyOnTranscript('x');
  await settle(100);
  const window = opened as ChatWindow;
  const entry = entries(window).find(
    (candidate) => candidate === window.document.activeElement,
  );
  assert.ok(entry, 'the new comment holds the caret');
  await write(entry, note);
  await press(entry, 'Enter');
  await settle(50);
  return entry;
};

/** Selects the words, then writes a comment on them and commits it. */
const comment = async (
  words: string,
  note: string,
  how: { readonly backwards?: boolean; readonly nth?: number } = {},
): Promise<HTMLElement> => {
  await select(words, how);
  return typeComment(note);
};

/**
 * Makes the platform's caret-from-point name a position inside the answer's
 * `words`, `into` along — the point the pointer stands over — and answers the
 * element drawn there, the one the pointer is over.
 */
const pointAt = (
  window: ChatWindow,
  words: string,
  into: number,
): HTMLElement => {
  const run = drawnRun(window, words);
  const offset = run.data.indexOf(words) + into;
  Object.defineProperty(window.document, 'caretRangeFromPoint', {
    configurable: true,
    value: () => {
      const range = window.document.createRange();
      range.setStart(run, offset);
      return range;
    },
  });
  const element = run.parentElement;
  assert.ok(element, `“${words}” is drawn in an element`);
  return element;
};

/** A composition event carrying `data`, which happy-dom's constructor drops. */
const composition = (type: string, data?: string): CompositionEvent => {
  const event = new CompositionEvent(type, { bubbles: true });
  if (data !== undefined) Object.defineProperty(event, 'data', { value: data });
  return event;
};

/** Moves the pointer over an element of the transcript and lets a frame pass. */
const hoverTranscript = async (over: Element): Promise<void> => {
  over.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }),
  );
  await settle(50);
};

/** The transcript's elements that wear the pointer cursor, its root included. */
const pointerCursors = (): Element[] => {
  const root = rootOf();
  return [root, ...root.querySelectorAll('*')].filter((element) =>
    element.hasAttribute('data-comment-hover'),
  );
};

test('selecting alone draws nothing; typing over the selection opens a comment after its paragraph, holding the typed character', async () => {
  const window = await open();
  await select('src/parser.ts');

  assert.equal(seat(window), null, 'a selection alone opens nothing');
  assert.equal(
    [...window.document.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Comment',
    ),
    false,
    'and floats no Comment button',
  );

  const typed = keyOnTranscript('q');
  await settle(100);

  assert.equal(typed.defaultPrevented, true, 'the answer is not edited');
  const paragraph = [
    ...window.document.querySelectorAll('[data-lexical-editor] p'),
  ].find((element) => element.textContent?.includes('src/parser.ts'));
  assert.ok(paragraph);
  assert.equal(paragraph.textContent, 'It lives in src/parser.ts.');
  const seated = seat(window);
  assert.ok(seated, 'the comment stands in the transcript');
  assert.equal(
    paragraph.compareDocumentPosition(seated) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
    'after the paragraph that held the selection',
  );
  const entry = entryOf(window);
  assert.ok(entry);
  assert.equal(entry.textContent, 'q');
  assert.equal(
    window.document.activeElement,
    entry,
    'the note takes the caret',
  );

  // The first character put the comment on the stack, under its own id.
  const item = onlyItem();
  assert.equal(item.note, 'q');
  assert.match(item.id, /^comment-/);
  const data = item.data as {
    seat?: { turn?: unknown; block?: unknown };
    target?: {
      anchor?: {
        form?: unknown;
        text?: unknown;
        turn?: unknown;
        block?: unknown;
      };
    };
  };
  assert.equal(data.target?.anchor?.form, 'range');
  assert.equal(data.target?.anchor?.text, 'src/parser.ts');
  assert.equal(data.seat?.block, 0);
  assert.deepEqual(
    { turn: data.seat?.turn, block: data.seat?.block },
    { turn: data.target?.anchor?.turn, block: data.target?.anchor?.block },
  );

  // One element, the note: no second card, no quote, no author name.
  assert.equal(seated.querySelectorAll('[role="textbox"]').length, 1);
  assert.equal(seated.textContent?.includes('src/parser.ts'), false);
  assert.equal(seated.textContent?.includes(READER_NAME), false);
});

test('chords, navigation keys, Escape and Tab over a selection keep their own meaning and open nothing', async () => {
  const window = await open();
  const root = rootOf();
  // The editor's own handlers listen on the root after the gesture's: a key
  // the gesture lets go of reaches them.
  const reached: string[] = [];
  const hear = (event: Event): void => {
    const { key, metaKey, ctrlKey, altKey } = event as KeyboardEvent;
    reached.push(
      `${metaKey ? 'Meta+' : ''}${ctrlKey ? 'Ctrl+' : ''}${altKey ? 'Alt+' : ''}${key}`,
    );
  };
  root.addEventListener('keydown', hear);

  for (const [key, modifiers] of [
    ['c', { metaKey: true }],
    ['c', { ctrlKey: true }],
    ['e', { altKey: true }],
    ['ArrowRight', {}],
    ['Escape', {}],
    ['Tab', {}],
  ] as const) {
    await select('src/parser.ts');
    keyOnTranscript(key, modifiers);
    await settle(50);
    assert.equal(seat(window), null, `${key} opens no comment`);
  }
  root.removeEventListener('keydown', hear);

  assert.deepEqual(reached, [
    'Meta+c',
    'Ctrl+c',
    'Alt+e',
    'ArrowRight',
    'Escape',
    'Tab',
  ]);
  assert.deepEqual(window.received('chat.composer/v1.addItem'), []);
});

/** The reader's prompt block, found by its type (the bundle's own class). */
const $prompt = (): ElementNode => {
  const prompt = $getRoot()
    .getChildren()
    .find((node) => node.getType() === 'user-prompt-node');
  assert.ok($isElementNode(prompt));
  return prompt;
};

test('a key over a selection that runs from the answer into the prompt, or over the prompt alone, is the prompt’s', async () => {
  const window = await open();
  const editor = conversationEditor();
  editor.update(
    () => {
      const prompt = $prompt();
      prompt.clear();
      prompt.append($createTextNode('my draft'));
    },
    { discrete: true },
  );
  await settle(50);
  const root = rootOf();
  const reached: string[] = [];
  const hear = (event: Event): void => {
    reached.push((event as KeyboardEvent).key);
  };
  root.addEventListener('keydown', hear);

  const selections: readonly (() => void)[] = [
    // From the answer's words into the reader's own draft.
    () => {
      const turn = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'agent-turn-node');
      assert.ok($isElementNode(turn));
      const run = turn
        .getAllTextNodes()
        .find((node) => node.getTextContent().includes('src/parser.ts'));
      const draft = $prompt().getAllTextNodes()[0];
      assert.ok(run && draft);
      const selection = $createRangeSelection();
      selection.anchor.set(run.getKey(), 12, 'text');
      selection.focus.set(draft.getKey(), 2, 'text');
      $setSelection(selection);
    },
    // Words of the draft.
    () => {
      $prompt().getAllTextNodes()[0]?.select(0, 2);
    },
    // A caret in the draft.
    () => {
      $prompt().getAllTextNodes()[0]?.select(3, 3);
    },
  ];
  for (const selectIt of selections) {
    editor.update(selectIt, { discrete: true });
    await settle(50);
    keyOnTranscript('z');
    await settle(50);
  }
  root.removeEventListener('keydown', hear);

  assert.deepEqual(reached, ['z', 'z', 'z'], 'every key reached the editor');
  assert.equal(seat(window), null);
  assert.deepEqual(window.received('chat.composer/v1.addItem'), []);
});

test('a dead key over the selection opens the comment before its composition starts, so the composed letter lands in the note', async () => {
  const window = await open();
  await select('src/parser.ts');

  const dead = keyOnTranscript('Dead');
  // At once, before the composition the key starts: the note holds the caret.
  const entry = entryOf(window);
  assert.ok(entry, 'the comment stands as the key is handled');
  assert.equal(window.document.activeElement, entry);
  assert.equal(dead.defaultPrevented, false, 'the composition is not stopped');

  // The composition, as the platform runs it in the focused note: ´ then e.
  entry.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true }),
  );
  entry.textContent = 'é';
  entry.dispatchEvent(new Event('input', { bubbles: true }));
  entry.dispatchEvent(composition('compositionend', 'é'));
  await settle(100);

  assert.equal(onlyItem().note, 'é');
  assert.equal(
    drawnRun(window, 'src/parser.ts').data,
    'It lives in src/parser.ts.',
    'the answer is untouched',
  );
});

test('a composition no key announced never edits the answer: its letters open the comment and the answer is drawn again', async () => {
  const window = await open();
  const editor = conversationEditor();
  await select('src/parser.ts');
  const root = rootOf();

  root.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true }),
  );
  // What the browser itself writes over the selected words while composing.
  const run = drawnRun(window, 'src/parser.ts');
  run.data = 'It lives in ã.';
  root.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertCompositionText',
      data: 'ã',
    }),
  );
  await settle(20);
  root.dispatchEvent(composition('compositionend', 'ã'));
  await settle(100);

  assert.equal(
    [...window.document.querySelectorAll('[data-lexical-editor] p')].some(
      (paragraph) => paragraph.textContent === 'It lives in src/parser.ts.',
    ),
    true,
    'the answer is drawn as the chat wrote it',
  );
  assert.equal(
    editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'agent-turn-node')
        ?.getTextContent()
        .includes('It lives in src/parser.ts.'),
    ),
    true,
    'and the editor holds it so',
  );
  const entry = entryOf(window);
  assert.ok(entry);
  assert.equal(entry.textContent, 'ã');
  assert.equal(onlyItem().note, 'ã');
});

test('the editor refuses a controlled insertion or a composition over the answer', async () => {
  const window = await open();
  const editor = conversationEditor();
  await select('src/parser.ts');

  editor.update(
    () => {
      editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'x');
      editor.dispatchCommand(
        COMPOSITION_START_COMMAND,
        new CompositionEvent('compositionstart'),
      );
    },
    { discrete: true },
  );
  await settle(50);

  assert.equal(drawnRun(window, 'It lives').data, 'It lives in src/parser.ts.');
  assert.equal(editor.isComposing(), false);
});

test('the note holds the caret by the time the key that opened it is handled, so the next key goes to it', async () => {
  const window = await open();
  await select('src/parser.ts');

  keyOnTranscript('a');

  // No wait: the comment is drawn while the key is handled.
  const entry = entryOf(window);
  assert.ok(entry);
  assert.equal(window.document.activeElement, entry);
  assert.equal(entry.textContent, 'a');
});

test('a paste or a text input over the selection opens a comment holding its words', async () => {
  const window = await open();
  await select('src/parser.ts');
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? 'pasted' : ''),
    },
  });
  rootOf().dispatchEvent(paste);
  await settle(100);

  assert.equal(paste.defaultPrevented, true);
  assert.equal(entryOf(window)?.textContent, 'pasted');

  rootOf().focus();
  await select('It lives');
  const input = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: 'é',
  });
  rootOf().dispatchEvent(input);
  await settle(100);

  assert.equal(input.defaultPrevented, true);
  assert.deepEqual(
    entries(window).map((entry) => entry.textContent),
    ['é', 'pasted'],
    'a second comment, before the first: its words come first',
  );
});

test('Shift+Enter writes a newline and Enter commits: the same note stays, editable in place, with the prompt focused', async () => {
  const window = await open();
  await opening('src/parser.ts');
  const entry = entryOf(window);
  assert.ok(entry);
  await write(entry, 'line one');

  const newline = await press(entry, 'Enter', { shiftKey: true });
  assert.equal(newline.defaultPrevented, false);
  await write(entry, 'line one\nline two');

  const commit = await press(entry, 'Enter');
  assert.equal(commit.defaultPrevented, true);
  await settle(100);

  assert.equal(onlyItem().note, 'line one\nline two');
  assert.equal(entryOf(window), entry, 'the same note stands after the commit');
  assert.equal(entry.getAttribute('contenteditable'), 'true');
  assert.equal(entry.textContent, 'line one\nline two');
  assert.equal(window.document.activeElement, promptEditor().getRootElement());
  assert.deepEqual(window.received('comments/v1.add'), []);
});

test('the selected words stay highlighted while the comment is written and after it is committed, and Escape removes both', async () => {
  const window = await open();
  const highlights = installHighlights(window);
  await opening('src/parser.ts');
  const entry = entryOf(window);
  assert.ok(entry);

  assert.deepEqual(highlighted(highlights), ['src/parser.ts'], 'while written');
  await press(entry, 'Enter');
  await settle(50);
  assert.deepEqual(highlighted(highlights), ['src/parser.ts'], 'committed');

  const { id } = onlyItem();
  entry.focus();
  const escaped = await press(entry, 'Escape');
  await settle(100);

  assert.equal(escaped.defaultPrevented, true);
  assert.deepEqual(
    window.received('chat.composer/v1.removeItem').map((call) => call.input),
    [{ threadId, id }],
  );
  assert.equal(composer?.items.length, 0, 'the comment left the stack');
  assert.equal(seat(window), null, 'the seat left the transcript');
  assert.deepEqual(highlighted(highlights), [], 'the highlight went with it');
  assert.equal(window.document.activeElement, promptEditor().getRootElement());
});

test('Backspace on an emptied note removes the comment and its highlight; with words it edits the note', async () => {
  const window = await open();
  const highlights = installHighlights(window);
  await opening('src/parser.ts');
  const entry = entryOf(window);
  assert.ok(entry);
  await write(entry, 'xy');

  const editing = await press(entry, 'Backspace');
  assert.equal(editing.defaultPrevented, false, 'words: the note’s own edit');

  const { id } = onlyItem();
  await write(entry, '');
  const backspace = await press(entry, 'Backspace');
  await settle(100);

  assert.equal(backspace.defaultPrevented, true);
  assert.deepEqual(
    window.received('chat.composer/v1.removeItem').map((call) => call.input),
    [{ threadId, id }],
  );
  assert.equal(seat(window), null);
  assert.deepEqual(highlighted(highlights), []);
});

test('leaving a written comment keeps it as written; leaving one without words removes it', async () => {
  const window = await open();
  const highlights = installHighlights(window);
  await opening('src/parser.ts');
  const entry = entryOf(window);
  assert.ok(entry);
  await write(entry, 'some words');

  entry.blur();
  await settle(100);

  assert.deepEqual(window.received('chat.composer/v1.removeItem'), []);
  assert.equal(onlyItem().note, 'some words');
  assert.equal(entryOf(window), entry);
  assert.deepEqual(highlighted(highlights), ['src/parser.ts']);

  await opening('It lives', {}, ' ');
  const blank = entries(window).find((note) => note.textContent === ' ');
  assert.ok(blank, 'a second comment, holding only a space');
  blank.blur();
  await settle(100);

  assert.equal(entries(window).length, 1, 'the blank comment left');
  assert.deepEqual(highlighted(highlights), ['src/parser.ts']);
  assert.equal(window.received('chat.composer/v1.addItem').length, 1);
});

test('a note of only whitespace is empty: it adds nothing, and Backspace removes it', async () => {
  const window = await open();
  await opening('src/parser.ts', {}, ' ');
  const entry = entryOf(window);
  assert.ok(entry);
  await write(entry, '   ');

  assert.deepEqual(window.received('chat.composer/v1.addItem'), []);
  const backspace = await press(entry, 'Backspace');
  await settle(100);

  assert.equal(backspace.defaultPrevented, true);
  assert.equal(seat(window), null);
});

test('several comments on one paragraph stand in the order of their passages, each highlighted', async () => {
  const window = await open();
  const highlights = installHighlights(window);
  await comment('src/parser.ts', 'the later passage');
  await comment('It lives', 'the earlier passage');

  assert.deepEqual(
    entries(window).map((entry) => entry.textContent),
    ['the earlier passage', 'the later passage'],
  );
  assert.deepEqual(highlighted(highlights).sort(), [
    'It lives',
    'src/parser.ts',
  ]);
  assert.equal(composer?.items.length, 2, 'two comments on the stack');
});

test('opening a comment leaves the comments already written in the answer standing as they were', async () => {
  const window = await open(twoParagraphs);
  const editor = conversationEditor();
  const first = await comment('src/parser.ts', 'the later block');
  const firstSeat = seat(window);
  assert.ok(firstSeat);
  const firstKey = editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .flatMap((node) => ($isElementNode(node) ? node.getChildren() : []))
      .find((node) => node.getType() === 'chat-comment-seat-node')
      ?.getKey(),
  );
  assert.ok(firstKey);
  const written = new Set<string>();
  const unregister = editor.registerUpdateListener(
    ({ dirtyElements, dirtyLeaves }) => {
      for (const key of [...dirtyElements.keys(), ...dirtyLeaves])
        written.add(key);
    },
  );

  await comment('parser moved', 'the earlier block');
  unregister();

  assert.deepEqual(
    entries(window).map((entry) => entry.textContent),
    ['the earlier block', 'the later block'],
  );
  assert.equal(
    written.has(firstKey),
    false,
    'the first comment is not redrawn',
  );
  assert.equal(window.document.contains(firstSeat), true);
  assert.equal(window.document.contains(first), true, 'nor its note remounted');
});

test('a comment written in the answer is also listed on the stack inside the prompt, where an edit reaches it', async () => {
  const window = await open();
  const entry = await comment('src/parser.ts', 'inline and stacked');

  const section = stackSection(window);
  assert.ok(section, 'the stack draws the comment');
  assert.match(section.textContent ?? '', /inline and stacked/);

  // Written again on the stack's line, the comment reads the same inline.
  const line = section.querySelector<HTMLElement>('[data-stack-note]');
  assert.ok(line);
  await write(line, 'edited on the stack');
  line.blur();
  await settle(100);

  assert.equal(entry.textContent, 'edited on the stack');
});

test('an edit written in the answer shows on the stack’s line while the reader writes on', async () => {
  const window = await open();
  const entry = await comment('src/parser.ts', 'first words');
  const line =
    stackSection(window)?.querySelector<HTMLElement>('[data-stack-note]');
  assert.ok(line);

  await write(entry, 'first words, then more');

  assert.equal(window.document.activeElement, entry);
  assert.equal(line.textContent, 'first words, then more');
});

test('ArrowUp from the prompt goes to the stack’s line, never to the comment written in the transcript', async () => {
  const window = await open();
  const entry = await comment('src/parser.ts', 'inline');
  const prompt = promptEditor().getRootElement();
  assert.ok(prompt);
  assert.equal(window.document.activeElement, prompt);

  await press(prompt, 'ArrowUp');
  await settle(50);

  assert.notEqual(window.document.activeElement, entry);
  assert.equal(
    window.document.activeElement?.closest('[data-composer-stack-list]') !==
      null,
    true,
    'the caret is on the stack’s line',
  );
});

test('a click on the highlighted words puts the caret back in their comment; one beside them or on their edges does not', async () => {
  const window = await open();
  const entry = await comment('src/parser.ts', 'look here');
  assert.notEqual(window.document.activeElement, entry);

  await click(window, 'It lives', 1);
  assert.notEqual(window.document.activeElement, entry, 'beside');
  await click(window, 'src/parser.ts', 0);
  assert.notEqual(window.document.activeElement, entry, 'the start edge');
  await click(window, 'src/parser.ts', 'src/parser.ts'.length);
  assert.notEqual(window.document.activeElement, entry, 'the end edge');

  await click(window, 'src/parser.ts', 3);
  assert.equal(window.document.activeElement, entry, 'inside');
  const caret = window.document.getSelection();
  assert.equal(
    caret?.anchorNode !== null &&
      caret?.anchorNode !== undefined &&
      entry.contains(caret.anchorNode),
    true,
    'the caret stands in the note, to edit it',
  );
});

test('where commented passages overlap, a click goes to the newest comment', async () => {
  const window = await open();
  await comment('src/parser.ts', 'first');
  await comment('in src/parser', 'newest');

  await click(window, 'src/parser.ts', 3);

  assert.equal(window.document.activeElement?.textContent, 'newest');
});

test('the passage under the pointer shows it can be clicked, and stops when the pointer leaves it', async () => {
  const window = await open();
  const highlights = installHighlights(window);
  await comment('src/parser.ts', 'hover me');

  const over = pointAt(window, 'src/parser.ts', 3);
  await hoverTranscript(over);
  // The cursor is the element's under the pointer alone: the whole transcript
  // restyled on every hover is a frame too slow to follow the pointer.
  assert.deepEqual(pointerCursors(), [over], 'pointer cursor');
  assert.deepEqual(
    [...(highlights.get('chat-comment-hover') ?? [])].map((range) =>
      range.toString(),
    ),
    ['src/parser.ts'],
  );

  await hoverTranscript(pointAt(window, 'It lives', 1));
  assert.deepEqual(pointerCursors(), []);
  assert.deepEqual([...(highlights.get('chat-comment-hover') ?? [])], []);
});

test('the passage of the comment being written wears the stronger highlight for as long as its note holds the focus', async () => {
  const window = await open();
  const highlights = installHighlights(window);
  const stronger = (): string[] =>
    [...(highlights.get('chat-comment-hover') ?? [])].map((range) =>
      range.toString(),
    );

  await select('src/parser.ts');
  keyOnTranscript('x');
  await settle(100);
  const entry = entries(window).find(
    (candidate) => candidate === window.document.activeElement,
  );
  assert.ok(entry, 'the new comment holds the caret');
  assert.deepEqual(stronger(), ['src/parser.ts'], 'while it is written');
  assert.deepEqual(pointerCursors(), [], 'the focus takes no pointer cursor');

  await write(entry, 'focused');
  await press(entry, 'Enter');
  await settle(50);
  assert.deepEqual(stronger(), [], 'committed, the caret back in the prompt');

  await click(window, 'src/parser.ts', 3);
  assert.equal(window.document.activeElement, entry);
  assert.deepEqual(stronger(), ['src/parser.ts'], 'edited again');
});

test('once the send flushes the comment off the stack, its seat and highlight leave the transcript', async () => {
  const window = await open();
  const highlights = installHighlights(window);
  await comment('src/parser.ts', 'a note');

  const fake = composer;
  assert.ok(fake);
  const { id } = onlyItem();
  fake.items = [];
  for (const stream of fake.streams) {
    stream.push({ kind: 'removed', threadId, id });
  }
  await settle(100);

  assert.equal(seat(window), null);
  assert.deepEqual(highlighted(highlights), []);
});

test('the window’s send finds the note as last written, even while its item is still being added', async () => {
  const window = await open();
  const fake = composer;
  assert.ok(fake);
  // The add is still out while the reader writes on and sends.
  fake.addDelay = 500;
  await opening('src/parser.ts', {}, 'a');
  const entry = entryOf(window);
  assert.ok(entry);
  entry.textContent = 'ab';
  entry.dispatchEvent(new Event('input', { bubbles: true }));

  const pending: Promise<unknown>[] = [];
  window.document.dispatchEvent(
    new CustomEvent('doric:prompt-send', {
      detail: {
        threadId,
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      },
    }),
  );
  assert.equal(pending.length, 1, 'the send waits for the add');
  await Promise.allSettled(pending);
  await settle(0);

  const notes = [
    ...window
      .received('chat.composer/v1.addItem')
      .map((call) => (call.input as { note?: string }).note),
    ...window
      .received('chat.composer/v1.updateNote')
      .map((call) => (call.input as { note?: string }).note),
  ];
  assert.equal(notes.at(-1), 'ab', 'the service holds the note as written');
  assert.equal(window.received('chat.composer/v1.addItem').length, 1);
});

test('a selection dragged backwards in a later paragraph seats the comment after that paragraph, highlighting the occurrence selected', async () => {
  const window = await open(twoParagraphs);
  const highlights = installHighlights(window);
  await comment('src/parser.ts', 'why twice?', { backwards: true, nth: 1 });

  const data = onlyItem().data as {
    seat?: { block?: unknown; at?: unknown };
    target?: { anchor?: { at?: unknown } };
  };
  assert.equal(data.seat?.block, 1, 'the second paragraph is block 1');
  // The anchor says which occurrence was selected, for every reader of it.
  assert.equal(
    data.target?.anchor?.at,
    'Readsrc/parser.ts,then'.length,
    'the second occurrence, whitespace aside',
  );
  assert.equal(data.target?.anchor?.at, data.seat?.at);
  const second = [
    ...window.document.querySelectorAll('[data-lexical-editor] p'),
  ].find((element) => element.textContent?.startsWith('Read'));
  const seated = seat(window);
  assert.ok(second);
  assert.ok(seated);
  assert.equal(
    second.compareDocumentPosition(seated) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const [range] = highlights.get('chat-comment') ?? [];
  assert.equal(range?.toString(), 'src/parser.ts');
  assert.equal(second.contains(range?.startContainer ?? null), true);
  assert.equal(range?.startOffset, 'Read src/parser.ts, then '.length);
});

test('a quote that runs over two paragraphs paints their words and never the comment between them, whose own caret a click keeps', async () => {
  const window = await open(twoParagraphs);
  const highlights = installHighlights(window);
  const editor = conversationEditor();
  editor.update(
    () => {
      const turn = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'agent-turn-node');
      assert.ok($isElementNode(turn));
      const [first, second] = turn.getAllTextNodes();
      assert.ok($isTextNode(first) && $isTextNode(second));
      const selection = $createRangeSelection();
      selection.anchor.set(first.getKey(), 'The parser '.length, 'text');
      selection.focus.set(second.getKey(), 'Read'.length, 'text');
      $setSelection(selection);
    },
    { discrete: true },
  );
  await settle(50);
  keyOnTranscript('a');
  await settle(100);
  const entry = entryOf(window);
  assert.ok(entry);
  await write(entry, 'a long note');

  const ranges = [...(highlights.get('chat-comment') ?? [])];
  assert.equal(
    ranges.map((range) => range.toString()).join('|'),
    'moved.|Read',
  );
  const seated = seat(window);
  assert.ok(seated);
  for (const range of ranges) {
    assert.equal(range.intersectsNode(seated), false);
  }

  const text = entry.firstChild;
  assert.ok(text);
  window.document.getSelection()?.collapse(text, 3);
  const pressed = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  entry.dispatchEvent(pressed);
  await settle(50);
  assert.equal(pressed.defaultPrevented, false);
  assert.equal(window.document.getSelection()?.anchorOffset, 3);
});

test('a conversation mounted again seats the comments the stack still holds, with their note and highlight', async () => {
  const first = await open();
  await comment('src/parser.ts', 'kept across a reload');
  const written = { ...onlyItem() };
  await first.close();
  opened = undefined;

  const window = await open(exchange, [written]);
  const highlights = installHighlights(window);
  await settle(100);
  // The registry was given after the window booted: the next update paints in
  // it, as the platform's own would have from the start.
  conversationEditor().update(() => $getRoot().markDirty(), {
    discrete: true,
  });
  await settle(50);

  const entry = entryOf(window);
  assert.ok(entry, 'the comment stands in the transcript again');
  assert.equal(entry.textContent, 'kept across a reload');
  assert.deepEqual(highlighted(highlights), ['src/parser.ts']);

  await write(entry, 'kept, and edited');
  // The edits of a burst reach the composer together, a moment later.
  await settle(200);
  const notes = window
    .received('chat.composer/v1.updateNote')
    .map((call) => call.input as { id: string; note: string });
  assert.deepEqual(notes.at(-1), {
    threadId,
    id: written.id,
    note: 'kept, and edited',
  });
  assert.deepEqual(window.received('chat.composer/v1.addItem'), []);
});

test('a stacked comment whose turn the transcript does not show is still listed on the stack', async () => {
  const window = await open(exchange, [
    {
      id: 'comment-older',
      kind: 'message',
      elementTag: 'chat-comment-line',
      author: READER_NAME,
      note: 'about an older answer',
      data: {
        target: {
          kind: 'message',
          id: promptId,
          anchor: { form: 'range', text: 'gone', turn: 'agent:gone', block: 0 },
        },
        seat: { turn: 'agent:gone', block: 0 },
      },
    },
  ]);
  await settle(100);

  assert.match(
    stackSection(window)?.textContent ?? '',
    /about an older answer/,
  );
  assert.equal(seat(window), null);
});

test('an undo neither takes a comment away nor brings a removed one back', async () => {
  const window = await open();
  const highlights = installHighlights(window);
  const editor = conversationEditor();
  const before = editor.getEditorState();

  await comment('src/parser.ts', 'still here');
  editor.dispatchCommand(UNDO_COMMAND, undefined);
  await settle(100);
  editor.setEditorState(before, { tag: HISTORIC_TAG });
  await settle(150);

  const back = entryOf(window);
  assert.ok(back, 'the comment stands after the undo');
  assert.equal(back.textContent, 'still here');
  assert.deepEqual(highlighted(highlights), ['src/parser.ts']);
  assert.equal(onlyItem().note, 'still here');

  const during = editor.getEditorState();
  back.focus();
  await press(back, 'Escape');
  await settle(100);
  assert.equal(seat(window), null);
  editor.setEditorState(during, { tag: HISTORIC_TAG });
  await settle(150);

  assert.equal(seat(window), null, 'the removed comment stays removed');
  assert.deepEqual(highlighted(highlights), []);
});

test('closing the conversation leaves its comments on the stack', async () => {
  const window = await open();
  await comment('src/parser.ts', 'keep me');
  const view = window.document.querySelector('chat-view');
  assert.ok(view);

  view.remove();
  await settle(200);

  assert.deepEqual(window.received('chat.composer/v1.removeItem'), []);
  assert.deepEqual(
    composer?.items.map((item) => item.note),
    ['keep me'],
    'the host still holds the comment',
  );
});

/** A finished exchange whose answer is `text`. */
const answering = (text: string) => [
  exchange[0],
  event(2, {
    type: 'prompt.finished',
    status: 'completed',
    text,
    source: { kind: 'user' },
  }),
];

/**
 * Selects from `from` (`fromAt` characters into it) to `to` (`toAt` into it),
 * the runs of the answer that hold those words, as a drag does.
 */
const selectBetween = async (
  from: string,
  fromAt: number,
  to: string,
  toAt: number,
): Promise<void> => {
  conversationEditor().update(
    () => {
      const turn = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'agent-turn-node');
      assert.ok($isElementNode(turn));
      const runs = turn.getAllTextNodes();
      const start = runs.find((run) => run.getTextContent().includes(from));
      const end = runs.find((run) => run.getTextContent().includes(to));
      assert.ok(start && end, `the answer holds “${from}” and “${to}”`);
      const selection = $createRangeSelection();
      selection.anchor.set(
        start.getKey(),
        start.getTextContent().indexOf(from) + fromAt,
        'text',
      );
      selection.focus.set(
        end.getKey(),
        end.getTextContent().indexOf(to) + toAt,
        'text',
      );
      $setSelection(selection);
    },
    { discrete: true },
  );
  await settle(50);
};

/** The answer's list items, as the window draws them (not the stack's cards). */
const listItems = (window: ChatWindow): HTMLElement[] =>
  [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-lexical-editor] li',
    ),
  ].filter((item) => item.closest('[data-composer-stack-list]') === null);

const listAnswer = [
  'Debts that still stand:',
  '',
  '- Selection across two paragraphs gets no paint',
  '- A repeated word paints the first one',
].join('\n');

test('a selection from a paragraph into a list item closes that item: the comment stands at its end, before the next item', async () => {
  const window = await open(answering(listAnswer));
  const highlights = installHighlights(window);
  await selectBetween('still stand', 0, 'across two', 'across two'.length);
  const entry = await typeComment('below the item');

  const [first, second] = listItems(window);
  assert.ok(first && second);
  assert.equal(first.contains(entry), true, 'in the first item');
  assert.equal(second.contains(entry), false);
  // The highlight paints the words of both blocks, never the comment's own.
  assert.deepEqual(highlighted(highlights), [
    'still stand:',
    'Selection across two',
  ]);
  const data = onlyItem().data as {
    seat?: { block?: unknown; after?: unknown; item?: unknown };
    target?: { anchor?: { block?: unknown } };
  };
  assert.deepEqual(
    { block: data.seat?.block, after: data.seat?.after, item: data.seat?.item },
    { block: 0, after: 1, item: 0 },
  );
  assert.equal(
    data.target?.anchor?.block,
    0,
    'the anchor names where the words start',
  );
});

test('a selection inside the first item of a numbered list closes that item, not the list', async () => {
  const window = await open(
    answering(
      [
        'Two bugs a review would have caught:',
        '',
        '1. Opening a second comment erased the first one',
        '2. Discarding a seat counted the paragraphs wrong',
      ].join('\n'),
    ),
  );
  await select('second comment');
  const entry = await typeComment('this one');

  const [first, second] = listItems(window);
  assert.ok(first && second);
  assert.equal(first.contains(entry), true);
  assert.equal(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(second.contains(entry), false);
  // The anchor names the item the words start in, for a reader going to them.
  const anchor = (
    onlyItem().data as {
      target?: { anchor?: { block?: unknown; item?: unknown } };
    }
  ).target?.anchor;
  assert.deepEqual(
    { block: anchor?.block, item: anchor?.item },
    { block: 1, item: 0 },
  );
});

test('a selection in a nested item closes that nested item', async () => {
  const window = await open(
    answering(['- top', '  - nested one', '  - nested two'].join('\n')),
  );
  await select('nested one');
  const entry = await typeComment('the nested one');

  const holder = listItems(window).find((item) => item.contains(entry));
  assert.ok(holder);
  assert.match(holder.textContent ?? '', /nested one/);
  assert.doesNotMatch(holder.textContent ?? '', /nested two|top/);
});

test('several comments on one list item stand at its end in passage order, each highlighted', async () => {
  const window = await open(answering(listAnswer));
  const highlights = installHighlights(window);
  await select('no paint');
  await typeComment('the later words');
  await select('Selection');
  await typeComment('the earlier words');

  const [first] = listItems(window);
  assert.ok(first);
  assert.deepEqual(
    [...first.querySelectorAll('[role="textbox"]')].map(
      (note) => note.textContent,
    ),
    ['the earlier words', 'the later words'],
  );
  assert.deepEqual(highlighted(highlights).sort(), ['Selection', 'no paint']);
});

test('a selection that runs onto the start of the next block closes the block its words end in', async () => {
  const window = await open(answering(listAnswer));
  await selectBetween('Debts', 0, 'Selection', 0);
  const entry = await typeComment('the paragraph only');

  assert.equal(
    listItems(window).some((item) => item.contains(entry)),
    false,
    'not in the list',
  );
  const paragraph = [
    ...window.document.querySelectorAll('[data-lexical-editor] p'),
  ].find((element) => element.textContent?.startsWith('Debts'));
  assert.ok(paragraph);
  assert.equal(
    paragraph.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test('a comment that closes a list item stands there again when the conversation mounts again', async () => {
  const first = await open(answering(listAnswer));
  await select('no paint');
  await typeComment('kept in the item');
  const kept = [...(composer?.items ?? [])];
  await first.close();
  opened = undefined;

  const window = await open(answering(listAnswer), kept);
  const [item] = listItems(window);
  assert.ok(item);
  assert.equal(
    item.querySelector('[role="textbox"]')?.textContent,
    'kept in the item',
  );
});

test('a comment written on several lines keeps them: after it loses the focus, on the stack and on the stack’s line', async () => {
  const window = await open();
  await opening('src/parser.ts');
  const entry = entryOf(window);
  assert.ok(entry);
  // Shift+Enter as the browser may write it: a `<br>` between the lines.
  entry.innerHTML = 'one<br>two<br>three';
  entry.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(50);

  entry.blur();
  await settle(100);

  assert.equal(
    onlyItem().note,
    'one\ntwo\nthree',
    'the stack holds the breaks',
  );
  const notes = window
    .received('chat.composer/v1.updateNote')
    .map((call) => (call.input as { note: string }).note);
  for (const note of notes) assert.match(note, /^one\ntwo/);
  // Both notes draw the breaks they hold, focused or not.
  const line =
    stackSection(window)?.querySelector<HTMLElement>('[data-stack-note]');
  assert.ok(line);
  assert.equal(line.textContent, 'one\ntwo\nthree');
  for (const note of [entry, line]) {
    assert.equal(note.classList.contains('whitespace-pre-wrap'), true);
    assert.equal(note.classList.contains('truncate'), false);
  }
});

test('a comment on several lines stands on them again when the conversation mounts again', async () => {
  const first = await open();
  await opening('src/parser.ts');
  const entry = entryOf(first);
  assert.ok(entry);
  entry.innerHTML = 'one<br>two';
  entry.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(50);
  const kept = [...(composer?.items ?? [])];
  await first.close();
  opened = undefined;

  const window = await open(exchange, kept);

  assert.equal(entryOf(window)?.textContent, 'one\ntwo');
});

test('a sent comment written on several lines is drawn on them in its turn', async () => {
  const window = await open([
    exchange[0],
    event(2, {
      type: 'comments.added/v1',
      commentId: 'comment-lines',
      target: {
        kind: 'message',
        id: promptId,
        anchor: { form: 'range', text: 'src/parser.ts' },
      },
      text: 'one\ntwo',
      author: READER_NAME,
    }),
    event(3, {
      type: 'prompt.finished',
      status: 'completed',
      text: 'It lives in src/parser.ts.',
      source: { kind: 'user' },
    }),
  ]);

  const note = [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-lexical-editor] [data-comment-line] span',
    ),
  ].find((span) => span.textContent === 'one\ntwo');
  assert.ok(note, 'the turn draws the note with its line break');
  assert.equal(note.classList.contains('whitespace-pre-wrap'), true);
});

/** Pushes one more event of the Thread's log, as the host streams it. */
const pushEvent = async (
  window: ChatWindow,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
  sequence: number,
): Promise<void> => {
  window
    .watches()
    .at(-1)
    ?.push({ kind: 'event', event: event(sequence, value) });
  await settle(200);
};

for (const [label, first, more, words] of [
  [
    'a list still growing',
    'Intro:\n\n- first item words\n- second',
    ' item grows',
    'first item',
  ],
  ['a paragraph', 'Intro paragraph words here', ' and more', 'paragraph words'],
] as const) {
  test(`a comment being written in ${label} keeps its focus, caret and words while the answer streams on`, async () => {
    const window = await open([
      exchange[0],
      event(2, { type: 'text.delta', delta: first }),
    ]);
    await select(words);
    keyOnTranscript('x');
    await settle(100);
    const entry = entryOf(window);
    assert.ok(entry);
    await write(entry, 'my note');
    const text = entry.firstChild;
    assert.ok(text);
    window.document.getSelection()?.collapse(text, 3);

    await pushEvent(window, { type: 'text.delta', delta: more }, 3);

    assert.match(
      window.document.querySelector('[data-lexical-editor]')?.textContent ?? '',
      new RegExp(more.trim()),
      'the delta landed',
    );
    assert.equal(entry.isConnected, true, 'the same note stands');
    assert.equal(window.document.activeElement, entry, 'it keeps the focus');
    assert.equal(entry.textContent, 'my note');
    assert.equal(window.document.getSelection()?.anchorOffset, 3);
    assert.deepEqual(window.received('chat.composer/v1.removeItem'), []);
  });
}

test('a delta that grows a list’s last item keeps the list and its items: the comment is never moved', async () => {
  const window = await open([
    exchange[0],
    event(2, {
      type: 'text.delta',
      delta: 'Intro:\n\n- first item words\n- second',
    }),
  ]);
  await select('first item');
  const entry = await typeComment('in the first item');
  const holder = listItems(window).find((item) => item.contains(entry));
  assert.ok(holder);

  await pushEvent(
    window,
    { type: 'text.delta', delta: ' item grows\n- third' },
    3,
  );

  assert.equal(listItems(window).length, 3, 'the delta landed');
  assert.equal(holder.isConnected, true, 'the same item element stands');
  assert.equal(holder.contains(entry), true);
});

test('a note that holds the caret gets it back when a redraw of its answer moves it', async () => {
  const window = await open(answering(listAnswer));
  await select('no paint');
  keyOnTranscript('x');
  await settle(100);
  const entry = entryOf(window);
  assert.ok(entry);
  await write(entry, 'still writing');
  const text = entry.firstChild;
  assert.ok(text);
  window.document.getSelection()?.collapse(text, 5);

  // The answer drawn again from its markdown: new blocks, the comment moved
  // into them, its element with it.
  conversationEditor().update(
    () => {
      const turn = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'agent-turn-node');
      (turn as unknown as { restore(): void }).restore();
    },
    { discrete: true },
  );
  await settle(100);

  assert.equal(window.document.activeElement, entry, 'the focus came back');
  assert.equal(window.document.getSelection()?.anchorOffset, 5);
  assert.equal(entry.textContent, 'still writing');
  assert.deepEqual(window.received('chat.composer/v1.removeItem'), []);
});
