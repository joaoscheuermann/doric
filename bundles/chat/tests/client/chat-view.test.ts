// The conversation as the reader meets it in a window: `<chat-view>` at a
// Thread's path, opened on the host's record and fed by the Thread's watch;
// the blocks other bundles project into it; the intents their cards emit;
// the footer composer; the mount hooks; and the editor's node list closing
// once the first editor exists.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

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

const hasPrompt = (window: ChatWindow): boolean =>
  window.document.querySelector(`[data-placeholder="${placeholder}"]`) !== null;

const textOf = (window: ChatWindow, selector: string): string | undefined =>
  window.document.querySelector(selector)?.textContent ?? undefined;

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
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

const workspaceProbe = (selected: () => unknown): Probe => ({
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
