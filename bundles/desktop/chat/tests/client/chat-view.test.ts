// The conversation as the reader meets it in a window: `<chat-view>` at a
// Thread's path, opened on the host's record and fed by the Thread's watch;
// the blocks other bundles project into it; the intents their cards emit;
// the footer composer; the mount hooks; and the editor's node list closing
// once the first editor exists.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { getExtensionDependencyFromEditor } from '@lexical/extension';
import {
  type ClientContext,
  CommandsV1,
  defineCommand,
  defineMethod,
  defineService,
  HooksV1,
  isContractError,
  ref,
  UiV1,
} from 'bundle/contracts';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  defineExtension,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  UNDO_COMMAND,
} from 'lexical';
import { z } from 'zod';

import {
  CHAT_INTENT_EVENT,
  ChatHooksV1,
  ChatLexicalV1,
  ChatViewsV1,
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
const path = `/projects/${projectId}/threads/${threadId}`;
const url = `doric://app${path}`;

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: threadId,
  name: 'Fix the parser',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
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
  createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
});

/** A finished exchange: the reader's prompt and the agent's answer. */
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

const emptyQueue = { revision: 1, paused: false, stopping: false, items: [] };

const host = (record: unknown, extra: Record<string, () => unknown> = {}) => ({
  'runtime.threads/v1.thread': () => record,
  'runtime.threads/v1.queue': () => emptyQueue,
  ...extra,
});

/** Opens the Thread's watch with a snapshot of `events`. */
const deliver = async (
  window: ChatWindow,
  events: readonly unknown[],
): Promise<void> => {
  const watch = window.watches().at(-1);
  assert.equal(
    watch !== undefined,
    true,
    'the conversation watches its Thread',
  );
  watch?.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events,
  });
  await settle(150);
};

const placeholder = 'Ask the agent to search, edit or build in this project…';

test('a compaction row expands its saved Markdown summary and keeps it open across transcript updates', async () => {
  opened = await openChatWindow({ url, host: host(thread()) });
  const summary = '# Preserved decisions\n\nKeep the **compact tabs**.';
  const events = [
    event(1, { type: 'compaction.started', trigger: 'manual' }),
    event(2, {
      type: 'compaction.finished',
      summaryId: 'summary-1',
      summary,
      condensedMessages: 12,
      tokensFreed: 4500,
    }),
  ];
  await deliver(opened, events.slice(0, 1));
  const progress = opened.document.querySelector('[role="status"] .shimmer');
  assert.equal(progress?.textContent, 'Compacting');
  const markerNode = progress?.closest('[data-slot="marker"]')?.parentElement;
  await deliver(opened, events);
  assert.equal(opened.document.querySelector('[role="status"] .shimmer'), null);
  const toggle = [...opened.document.querySelectorAll('button')].find(
    (button) => button.textContent?.includes('Contexto compactado'),
  );
  assert.ok(toggle);
  assert.equal(markerNode?.isConnected, true);
  assert.equal(opened.document.querySelector('h1')?.textContent, undefined);
  toggle.click();
  await settle();
  assert.match(
    opened.document.querySelector('h1')?.textContent ?? '',
    /Preserved decisions/,
  );
  assert.ok(
    [...opened.document.querySelectorAll('button')].some(
      (button) => button.textContent === 'Copiar',
    ),
  );
  await deliver(opened, [
    ...events,
    event(3, { type: 'text.delta', delta: 'Next answer' }),
  ]);
  assert.match(
    opened.document.querySelector('h1')?.textContent ?? '',
    /Preserved decisions/,
  );
});

const hasPrompt = (window: ChatWindow): boolean =>
  window.document.querySelector(`[data-placeholder="${placeholder}"]`) !== null;

const textOf = (window: ChatWindow, selector: string): string | undefined =>
  window.document.querySelector(selector)?.textContent ?? undefined;

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

test('streamed transcripts do not accumulate undo snapshots', async () => {
  let editor: LexicalEditor | undefined;
  opened = await openChatWindow({
    url,
    host: host(thread()),
    probe: {
      requires: ['chat.lexical/v1@^1.0.0'],
      activate: ({ services }: ClientContext) => {
        services.use(ChatLexicalV1).registerExtension(
          defineExtension({
            name: 'test/stream-history',
            register: (value) => {
              editor = value;
              return () => {};
            },
          }),
        );
      },
    },
  });
  await deliver(opened, exchange);
  assert.ok(editor);
  for (let index = 0; index < 20; index += 1) {
    await deliver(opened, [
      event(index + 3, {
        type: 'text.delta',
        delta: `Answer ${index} `,
      }),
    ]);
  }
  const { HistoryExtension } = await import('@lexical/history');
  const history = getExtensionDependencyFromEditor(
    editor,
    HistoryExtension,
  ).output.historyState.peek();
  assert.equal(history.undoStack.length, 0);
  assert.equal(history.redoStack.length, 0);
  assert.match(textOf(opened, 'chat-view') ?? '', /Answer 19/);
  for (let index = 0; index < 60; index += 1) {
    editor.update(
      () => {
        const prompt = $getRoot()
          .getChildren()
          .find((node) => node.getType() === 'user-prompt-node');
        assert.ok($isElementNode(prompt));
        const text = prompt.getFirstChild();
        if ($isTextNode(text)) text.setTextContent(`Draft ${index}`);
        else prompt.append($createTextNode(`Draft ${index}`));
        prompt.selectEnd();
      },
      { discrete: true, tag: HISTORY_PUSH_TAG },
    );
    await settle(1);
  }
  assert.equal(history.undoStack.length, 50);
  editor.dispatchCommand(UNDO_COMMAND, undefined);
  await settle();
  assert.equal(
    editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'user-prompt-node')
        ?.getTextContent(),
    ),
    'Draft 58',
  );
});

test('a Thread path opens its conversation with the transcript and the prompt', async () => {
  opened = await openChatWindow({ url, host: host(thread()) });
  await deliver(opened, exchange);

  const text = textOf(opened, 'chat-view') ?? '';
  assert.match(text, /Where is the parser\?/);
  assert.match(text, /It lives in src\/parser\.ts\./);
  assert.equal(hasPrompt(opened), true);
});

test('a Thread the host does not know draws no conversation', async () => {
  opened = await openChatWindow({ url, host: host(undefined) });
  await settle(50);

  assert.equal(opened.document.querySelector('chat-view') !== null, true);
  assert.equal(hasPrompt(opened), false);
  assert.equal(opened.watches().length, 0);
});

test('a versioned event nobody projects is drawn as a generic block', async () => {
  opened = await openChatWindow({ url, host: host(thread()) });
  await deliver(opened, [
    ...exchange,
    event(3, { type: 'files.saved/v1', path: 'src/parser.ts' }),
  ]);

  const text = textOf(opened, 'chat-block') ?? '';
  assert.match(text, /files\.saved\/v1/);
  assert.match(text, /"path": "src\/parser\.ts"/);
});

test('the events the built-in projection owns draw no external block', async () => {
  opened = await openChatWindow({ url, host: host(thread()) });
  await deliver(opened, [
    ...exchange,
    // An unversioned type the projection ignores today stays ignored.
    event(3, { type: 'something.internal' }),
  ]);

  assert.equal(opened.document.querySelector('chat-block') !== null, false);
});

// The probe bundle: what another bundle does with the chat's contracts.

interface ProbeCard extends HTMLElement {
  block?: { readonly data: unknown; readonly actions: readonly unknown[] };
}

/** A card element: shows its block and emits an intent when clicked. */
const cardClass = () => {
  const Base = globalThis.HTMLElement;
  return class Card extends Base {
    #block: ProbeCard['block'];
    get block() {
      return this.#block;
    }
    set block(value) {
      this.#block = value;
      this.textContent = `note ${JSON.stringify(value?.data)}`;
    }
    connectedCallback() {
      this.onclick = () =>
        this.dispatchEvent(
          new globalThis.CustomEvent(CHAT_INTENT_EVENT, {
            detail: { command: 'probe.open/v1', input: this.#block?.data },
            bubbles: true,
            composed: true,
          }),
        );
    }
  };
};

/** A projector of `probe.note/v1`: one block per note, counted. */
const notesProjector = {
  eventTypes: ['probe.note/v1'],
  initial: () => 0,
  reduce: (
    count: number,
    entry: { sequence: number; promptId: string; event: unknown },
  ) => ({
    state: count + 1,
    blocks: [
      {
        id: `note:${entry.sequence}`,
        type: 'probe.note',
        promptId: entry.promptId,
        sequence: entry.sequence,
        data: {
          count: count + 1,
          note: (entry.event as { text: string }).text,
        },
      },
    ],
  }),
};

const notesProbe = (opened: unknown[]): Probe => ({
  requires: [
    'chat.views/v1@^1.0.0',
    'chat.hooks/v1@^1.0.0',
    'ui/v1@^1.0.0',
    'hooks/v1@^1.0.0',
    'commands/v1@^1.0.0',
  ],
  activate: ({ services }: ClientContext) => {
    services.use(UiV1).define('probe-card', cardClass());
    const views = services.use(ChatViewsV1);
    views.registerProjector(notesProjector as never);
    views.registerRenderer({
      blockType: 'probe.note',
      elementTag: 'probe-card',
    });
    services.use(HooksV1).whenAvailable(ChatHooksV1, (hooks) => {
      hooks.onBeforeRenderBlockHook((block) => ({
        ...block,
        actions: [{ id: 'open', label: 'Open note' }],
      }));
    });
    services.use(CommandsV1).register(
      defineCommand({
        id: 'probe.open/v1',
        input: z.unknown(),
        execute: (input) => {
          opened.push(input);
        },
      }),
    );
  },
});

const card = (window: ChatWindow): ProbeCard | null =>
  window.document.querySelector('probe-card');

test("another bundle's projector and renderer draw its events among the turns, with the actions a hook adds", async () => {
  opened = await openChatWindow({
    url,
    host: host(thread()),
    probe: notesProbe([]),
  });
  await deliver(opened, [
    ...exchange,
    event(3, { type: 'probe.note/v1', text: 'remember' }),
  ]);

  const drawn = card(opened);
  assert.deepEqual(drawn?.block?.data, { count: 1, note: 'remember' });
  assert.deepEqual(drawn?.block?.actions, [{ id: 'open', label: 'Open note' }]);
  assert.equal(opened.document.querySelector('chat-block') !== null, false);
  // Seated after the turns its event follows, above the prompt.
  const editor = opened.document.querySelector('[data-lexical-editor]');
  const order = [...(editor?.children ?? [])].map((child) =>
    child.querySelector('probe-card') !== null
      ? 'card'
      : child.hasAttribute('data-prompt-input')
        ? 'prompt'
        : /It lives in src\/parser\.ts\./.test(child.textContent ?? '')
          ? 'answer'
          : undefined,
  );
  const seated = order.filter((entry) => entry !== undefined);
  assert.deepEqual(seated, ['answer', 'card', 'prompt']);
});

test('a later event of the same type updates the projection and keeps the earlier block', async () => {
  opened = await openChatWindow({
    url,
    host: host(thread()),
    probe: notesProbe([]),
  });
  await deliver(opened, [event(1, { type: 'probe.note/v1', text: 'first' })]);
  opened
    .watches()
    .at(-1)
    ?.push({
      kind: 'event',
      event: event(2, { type: 'probe.note/v1', text: 'second' }),
    });
  await settle(250);

  const cards = [...opened.document.querySelectorAll('probe-card')].map(
    (element) => (element as ProbeCard).block?.data,
  );
  assert.deepEqual(cards, [
    { count: 1, note: 'first' },
    { count: 2, note: 'second' },
  ]);
});

test("a card's intent runs its command with the card's input", async () => {
  const received: unknown[] = [];
  opened = await openChatWindow({
    url,
    host: host(thread()),
    probe: notesProbe(received),
  });
  await deliver(opened, [event(1, { type: 'probe.note/v1', text: 'go' })]);

  card(opened)?.click();
  await settle();

  assert.deepEqual(received, [{ count: 1, note: 'go' }]);
});

test('opening and leaving a conversation runs the mount hooks with its Thread', async () => {
  const seen: string[] = [];
  opened = await openChatWindow({
    url,
    host: host(thread()),
    probe: {
      requires: ['chat.hooks/v1@^1.0.0', 'hooks/v1@^1.0.0'],
      activate: ({ services }: ClientContext) => {
        services.use(HooksV1).whenAvailable(ChatHooksV1, (hooks) => {
          hooks.onMountHook((input) => {
            seen.push(`mount ${input.projectId} ${input.threadId}`);
          });
          hooks.onUnmountHook((input) => {
            seen.push(`unmount ${input.projectId} ${input.threadId}`);
          });
        });
      },
    },
  });
  await settle(50);
  assert.equal(seen.at(-1), `mount ${projectId} ${threadId}`);

  opened.window.history.pushState(null, '', '/elsewhere');
  opened.window.dispatchEvent(new opened.window.PopStateEvent('popstate'));
  await settle(50);
  assert.equal(seen.at(-1), `unmount ${projectId} ${threadId}`);
});

test('editor nodes are accepted until the first conversation editor exists, then refused as frozen', async () => {
  let lexical:
    | { registerNodes(nodes: readonly unknown[]): unknown }
    | undefined;
  opened = await openChatWindow({
    url: 'doric://app/elsewhere',
    host: host(thread()),
    probe: {
      requires: ['chat.lexical/v1@^1.0.0'],
      activate: ({ services }: ClientContext) => {
        lexical = services.use(ChatLexicalV1) as never;
      },
    },
  });
  const early = lexical?.registerNodes([]) as { dispose?: unknown };
  assert.equal(typeof early.dispose, 'function');

  opened.window.history.pushState(null, '', path);
  opened.window.dispatchEvent(new opened.window.PopStateEvent('popstate'));
  await settle(50);
  assert.equal(hasPrompt(opened), true);

  assert.throws(
    () => lexical?.registerNodes([]),
    (error: unknown) => isContractError(error) && error.code === 'frozen',
  );
});

// The footer composer, with a probe standing in for the layout's
// `layout.workspace/v1` (the selected Thread).

const workspaceProbe = (
  selected: () => unknown,
  record?: (id: string) => unknown,
): Probe => ({
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
          execute: (id: string) => {
            if (record) return record(id);
            const current = selected() as { id?: string } | undefined;
            return current?.id === id ? current : undefined;
          },
        }),
        selectedThread: defineMethod({
          input: z.tuple([]),
          output: z.unknown(),
          execute: () => selected(),
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

const footer = async (window: ChatWindow): Promise<Element> => {
  const region = window.document.createElement('core-region');
  region.setAttribute('name', 'layout.footer');
  window.document.body.append(region);
  await settle(50);
  return region as unknown as Element;
};

const button = (root: Element, label: string): HTMLButtonElement | null =>
  root.querySelector(`button[aria-label="${label}"]`);

test('without a selected Thread the composer offers a disabled send', async () => {
  opened = await openChatWindow({
    url: 'doric://app/elsewhere',
    host: host(thread()),
  });
  const region = await footer(opened);

  const send = button(region, 'Send (Cmd+Enter)');
  assert.equal(send !== null, true);
  assert.equal(send?.disabled, true);
});

test('while the selected Thread runs, the composer pauses its active prompt', async () => {
  opened = await openChatWindow({
    url: 'doric://app/elsewhere',
    host: host(thread(), {
      'runtime.threads/v1.pause': () => 'interrupted',
    }),
    probe: workspaceProbe(() =>
      thread({ state: 'running', activePromptId: promptId }),
    ),
  });
  const region = await footer(opened);

  const pause = button(region, 'Pause (Esc)');
  assert.equal(pause !== null, true);
  pause?.click();
  await settle();

  const paused = opened
    .received('runtime.threads/v1.pause')
    .map((envelope) => envelope.input);
  assert.deepEqual(paused, [{ id: threadId, promptId }]);
});

test('two conversations keep their drafts and footer sends scoped to their own Thread', async () => {
  const childId = '44444444-4444-4444-8444-444444444444';
  const records = [thread(), thread({ id: childId, parentThreadId: threadId })];
  const editors = new Set<LexicalEditor>();
  let create:
    | ((tag: string, props: Record<string, string>) => HTMLElement)
    | undefined;
  const workspace = workspaceProbe(
    () => records[0],
    (id) => records.find((entry) => entry.id === id),
  );
  opened = await openChatWindow({
    url: 'doric://app/elsewhere',
    host: host(thread(), {
      'runtime.threads/v1.prompt': () => ({ status: 'accepted', promptId }),
    }),
    probe: {
      provides: workspace.provides,
      requires: ['chat.lexical/v1@^1.0.0', 'ui/v1@^1.0.0'],
      activate: async (context: ClientContext) => {
        await workspace.activate(context);
        const ui = context.services.use(UiV1);
        create = (tag, props) => ui.create(tag, props) as HTMLElement;
        context.services.use(ChatLexicalV1).registerExtension(
          defineExtension({
            name: 'test/editor-input',
            register: (editor) => {
              editors.add(editor);
              return () => {
                editors.delete(editor);
              };
            },
          }),
        );
      },
    },
  });
  assert.ok(create);
  const main = create('chat-view', { projectId, threadId });
  opened.document.body.append(main);
  const mainFooter = await footer(opened);
  const mainEditor = main.querySelector<HTMLElement>(
    '[contenteditable="true"]',
  );
  assert.ok(mainEditor);
  mainEditor.focus();
  const panel = create('chat-thread-panel', { projectId, threadId: childId });
  opened.document.body.append(panel);
  await settle(100);
  assert.equal(
    opened.document.activeElement,
    mainEditor,
    'mounting a child panel preserves main-editor focus',
  );
  const type = async (root: Element, text: string) => {
    const editor = [...editors].find((candidate) =>
      root.contains(candidate.getRootElement()),
    );
    assert.ok(editor);
    editor.update(() => {
      const prompt = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'user-prompt-node');
      assert.ok($isElementNode(prompt));
      prompt.clear().append($createTextNode(text));
    });
    await settle();
  };
  await type(main, 'Keep this main draft');
  await type(panel, 'Send only this child draft');
  button(panel, 'Send (Cmd+Enter)')?.click();
  await settle(50);
  assert.deepEqual(
    opened.received('runtime.threads/v1.prompt').map((call) => call.input),
    // Words alone travel as the envelope's message.
    [
      {
        id: childId,
        prompt: '<message>\nSend only this child draft\n</message>',
      },
    ],
  );
  assert.match(main.textContent ?? '', /Keep this main draft/);
  button(mainFooter, 'Send (Cmd+Enter)')?.click();
  await settle(50);
  assert.deepEqual(
    opened.received('runtime.threads/v1.prompt').map((call) => call.input),
    [
      {
        id: childId,
        prompt: '<message>\nSend only this child draft\n</message>',
      },
      { id: threadId, prompt: '<message>\nKeep this main draft\n</message>' },
    ],
  );
});

test('a child conversation footer pauses its Thread while the main Thread stays selected', async () => {
  const childId = '44444444-4444-4444-8444-444444444444';
  const childPrompt = '55555555-5555-4555-8555-555555555555';
  let create:
    | ((tag: string, props: Record<string, string>) => HTMLElement)
    | undefined;
  const records = [
    thread({ state: 'running', activePromptId: promptId }),
    thread({ id: childId, state: 'running', activePromptId: childPrompt }),
  ];
  const workspace = workspaceProbe(
    () => records[0],
    (id) => records.find((entry) => entry.id === id),
  );
  opened = await openChatWindow({
    url,
    host: host(thread(), { 'runtime.threads/v1.pause': () => 'interrupted' }),
    probe: {
      provides: workspace.provides,
      requires: ['ui/v1@^1.0.0'],
      activate: async (context: ClientContext) => {
        await workspace.activate(context);
        const ui = context.services.use(UiV1);
        create = (tag, props) => ui.create(tag, props) as HTMLElement;
      },
    },
  });
  const mainFooter = await footer(opened);
  assert.ok(create);
  const panel = create('chat-thread-panel', { projectId, threadId: childId });
  opened.document.body.append(panel);
  await settle(100);
  assert.ok(button(panel, 'Pause (Esc)'));
  button(panel, 'Pause (Esc)')?.click();
  await settle();
  assert.deepEqual(
    opened.received('runtime.threads/v1.pause').map((call) => call.input),
    [{ id: childId, promptId: childPrompt }],
  );
  button(mainFooter, 'Pause (Esc)')?.click();
  await settle();
  assert.deepEqual(
    opened.received('runtime.threads/v1.pause').map((call) => call.input),
    [
      { id: childId, promptId: childPrompt },
      { id: threadId, promptId },
    ],
  );
});

// R-9.7 and R-9.9: another Thread's input. Chat draws it itself until a
// bundle registers a renderer for `chat.delegated-input/v1`; then the turn
// hosts that element, handing it the block, and the element can show the
// text with `<chat-readonly-markdown>`.

const parentThreadId = '44444444-4444-4444-8444-444444444444';

const delegatedExchange = [
  event(1, {
    type: 'prompt.accepted',
    text: 'Fix the parser first.',
    source: { kind: 'parent', threadId: parentThreadId },
  }),
];

const turnOf = (window: ChatWindow): HTMLElement | null =>
  window.document.querySelector(`[data-prompt-id="${promptId}"]`);

test('a delegated instruction is drawn by chat while no bundle renders it', async () => {
  opened = await openChatWindow({ url, host: host(thread()) });
  await settle();
  await deliver(opened, delegatedExchange);

  const turn = turnOf(opened);
  assert.match(turn?.textContent ?? '', /Instruction from:/);
  assert.equal(
    turn?.querySelector('.editor-paragraph')?.textContent,
    'Fix the parser first.',
  );
});

test('a registered renderer draws the delegated input with the read-only Markdown element', async () => {
  const blocks: unknown[] = [];
  opened = await openChatWindow({
    url,
    host: host(thread()),
    probe: {
      requires: ['chat.views/v1@^1.0.0', 'ui/v1@^1.0.0'],
      activate: ({ services }: ClientContext) => {
        const ui = services.use(UiV1);
        const Base = globalThis.HTMLElement;
        ui.define(
          'probe-delegated',
          class extends Base {
            #block: unknown;
            focused = false;
            chosen = true;
            toggle() {
              this.chosen = !this.chosen;
            }
            get block() {
              return this.#block;
            }
            set block(value: unknown) {
              this.#block = value;
              blocks.push(value);
              const input = (
                value as { data: { input: { text: string } } } | undefined
              )?.data.input;
              if (input === undefined || this.childElementCount > 0) return;
              this.append(
                ui.create('chat-readonly-markdown', {
                  text: input.text,
                }) as Node,
              );
            }
          },
        );
        services.use(ChatViewsV1).registerRenderer({
          blockType: 'chat.delegated-input/v1',
          elementTag: 'probe-delegated',
        });
      },
    },
  });
  await settle();
  await deliver(opened, delegatedExchange);

  const turn = turnOf(opened);
  assert.notEqual(turn?.querySelector('probe-delegated'), null);
  assert.doesNotMatch(turn?.textContent ?? '', /Instruction from:/);
  // The conversation's read-only Markdown, in the conversation's theme.
  assert.equal(
    turn?.querySelector('probe-delegated .editor-paragraph')?.textContent,
    'Fix the parser first.',
  );
  assert.deepEqual(blocks.at(-1), {
    type: 'chat.delegated-input/v1',
    id: (blocks.at(-1) as { id: string }).id,
    data: {
      promptId,
      input: {
        kind: 'parent',
        threadId: parentThreadId,
        text: 'Fix the parser first.',
      },
    },
  });
});

test('edit tool calls stand outside the activity summary with their diff while terminal calls fold into the summary with their shell view', async () => {
  opened = await openChatWindow({
    url,
    host: host(thread()),
  });
  await deliver(opened, [
    event(1, {
      type: 'prompt.accepted',
      text: 'Update parser and run tests',
      source: { kind: 'user' },
    }),
    event(2, {
      type: 'reasoning.delta',
      delta: 'Checking the test suite first.',
    }),
    event(3, {
      type: 'tool.started',
      call: {
        id: 'call-term-1',
        name: 'terminal',
        payload: { command: 'npm test', working_directory: '/workspace' },
      },
    }),
    event(4, {
      type: 'tool.finished',
      call: {
        id: 'call-term-1',
        name: 'terminal',
        payload: { command: 'npm test', working_directory: '/workspace' },
      },
      record: {
        output: JSON.stringify({
          schema: 'terminal.compact.v1',
          trace_id: null,
          command: 'npm test',
          working_directory: '/workspace',
          exit_code: 0,
          duration_ms: 1200,
          termination_reason: 'exited',
          success: true,
          stdout: {
            bytes: 12,
            lines: 1,
            head: ['1 passing'],
            tail: [],
            omitted_lines: 0,
            omitted_bytes: 0,
            truncated: false,
          },
          stderr: {
            bytes: 0,
            lines: 0,
            head: [],
            tail: [],
            omitted_lines: 0,
            omitted_bytes: 0,
            truncated: false,
          },
          diagnostics: [],
          truncation: { truncated: false, message: 'ok' },
          raw_output_ref: null,
        }),
      },
    }),
    event(5, {
      type: 'tool.started',
      call: {
        id: 'call-edit-1',
        name: 'edit',
        payload: {
          path: 'src/parser.ts',
          edits: [
            {
              oldText: 'const old = 1;',
              newText: 'const next = 2;\nexport { next };',
            },
          ],
        },
      },
    }),
    event(6, {
      type: 'tool.finished',
      call: {
        id: 'call-edit-1',
        name: 'edit',
        payload: {
          path: 'src/parser.ts',
          edits: [
            {
              oldText: 'const old = 1;',
              newText: 'const next = 2;\nexport { next };',
            },
          ],
        },
      },
      record: {
        output: JSON.stringify({
          success: true,
          diff: ' 1 -const old = 1;\n 1 +const next = 2;\n 2 +export { next };',
          first_changed_line: 1,
        }),
      },
    }),
    event(7, {
      type: 'prompt.finished',
      status: 'completed',
      text: 'Updated src/parser.ts.',
      source: { kind: 'user' },
    }),
  ]);

  const view = opened.document.querySelector('chat-view');
  assert.ok(view);

  // The edit block stands outside the activity summary with its diff open.
  const editTool = view.querySelector('[data-slot="edit-tool"]');
  assert.notEqual(editTool, null);
  assert.equal(
    editTool?.querySelector('[data-slot="edit-file-name"]')?.textContent,
    'parser.ts',
  );
  assert.equal(editTool?.querySelector('[data-slot="edit-file-dir"]'), null);
  assert.match(
    editTool?.querySelector('[data-slot="edit-counts"]')?.textContent ?? '',
    /\+2.*−1/,
  );
  assert.equal(
    editTool?.querySelectorAll('[data-slot="edit-diff-line"]').length,
    3,
  );

  // The terminal call is folded inside the activity summary ("Thought once, called 1 tool").
  assert.match(view.textContent ?? '', /Thought once, called 1 tool/);
  assert.equal(view.querySelector('[data-slot="terminal-tool"]'), null);

  // Opening the activity summary reveals the terminal tool card inside it.
  const triggers = [...view.querySelectorAll<HTMLElement>('button')];
  const summaryButton = triggers.find((button) =>
    button.textContent?.includes('Thought once, called 1 tool'),
  );
  assert.ok(summaryButton);
  summaryButton.click();
  await settle(50);

  const terminalTool = view.querySelector('[data-slot="terminal-tool"]');
  assert.notEqual(terminalTool, null);
  assert.equal(
    terminalTool?.querySelector('[data-slot="terminal-command-preview"]')
      ?.textContent,
    'npm test',
  );
});
