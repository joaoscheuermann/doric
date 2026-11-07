// A probe bundle that draws fences in a window (openui.md D1): it defines one
// custom element per fence tag through `ui/v1`, registers it through
// `chat.views/v1.registerFenceRenderer`, and writes down what the chat does
// with each element: created, connected with which `view`, disposed. Every
// element holds an `<input>`, standing for a control a renderer draws.

import { type ClientContext, type Disposable, UiV1 } from 'bundle/contracts';
import { $getRoot, defineExtension, type LexicalEditor } from 'lexical';

import {
  type ChatFenceView,
  ChatLexicalV1,
  type ChatViews,
  ChatViewsV1,
} from '../../../src/contracts/index.js';
import type { ChatWindow, Probe } from './window.js';

export const projectId = '11111111-1111-4111-8111-111111111111';
export const threadId = '22222222-2222-4222-8222-222222222222';
export const promptId = '33333333-3333-4333-8333-333333333333';
export const otherThreadId = '44444444-4444-4444-8444-444444444444';
export const threadPath = (id: string) =>
  `/projects/${projectId}/threads/${id}`;
export const threadUrl = (id: string) => `doric://app${threadPath(id)}`;

/** One fence element as the probe saw it. */
export interface FenceElement extends HTMLElement {
  view?: ChatFenceView;
  readonly tagName: string;
}

export interface FenceProbeState {
  readonly created: FenceElement[];
  /** Each `connectedCallback`, with the `view` the element held then. */
  readonly connected: { element: FenceElement; view: unknown }[];
  /** Each element `ui/v1.dispose` reached. */
  readonly disposed: FenceElement[];
  /** The registrations the probe made, by tag. */
  readonly registrations: Map<string, Disposable>;
  /** What a registration threw, when it did. */
  readonly errors: unknown[];
  views?: ChatViews;
  editor?: LexicalEditor;
  /** Registers a fence renderer of `tag` drawn by `elementTag`, as the probe. */
  register(tag: string, elementTag: string): void;
}

/** A Thread record as the host gives it. */
export const threadRecord = (
  id = threadId,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name: `Thread ${id.slice(0, 4)}`,
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

/** One logged event of `prompt` in `thread`. */
export const threadEvent = (
  sequence: number,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
  prompt = promptId,
  thread = threadId,
) => ({
  projectId,
  threadId: thread,
  promptId: prompt,
  sequence,
  type: value.type,
  event: value,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
});

/** A prompt that runs and has written `text` so far, its delta at sequence 4. */
export const answering = (
  text: string,
  prompt = promptId,
  thread = threadId,
) => [
  threadEvent(
    1,
    {
      type: 'prompt.accepted',
      text: 'Draw the form',
      source: { kind: 'user' },
    },
    prompt,
    thread,
  ),
  threadEvent(2, { type: 'prompt.started' }, prompt, thread),
  threadEvent(3, { type: 'agent.started' }, prompt, thread),
  threadEvent(4, { type: 'text.delta', delta: text }, prompt, thread),
];

/** The open `watchThread` stream of one Thread. */
export const streamOf = (window: ChatWindow, thread = threadId) =>
  window
    .watches()
    .filter((stream) => JSON.stringify(stream.envelope.input).includes(thread));

/** Answers a Thread's watch with a snapshot of `events`. */
export const snapshot = (
  window: ChatWindow,
  events: readonly unknown[],
  thread = threadId,
  record: unknown = threadRecord(thread),
): void => {
  const stream = streamOf(window, thread).at(-1);
  if (stream === undefined) throw new Error(`no watch of ${thread}`);
  stream.push({
    kind: 'snapshot',
    threadId: thread,
    projectId,
    project: null,
    thread: record,
    events,
  });
};

/** Pushes one live event on a Thread's watch. */
export const push = (
  window: ChatWindow,
  event: ReturnType<typeof threadEvent>,
  thread = threadId,
): void => {
  const stream = streamOf(window, thread).at(-1);
  if (stream === undefined) throw new Error(`no watch of ${thread}`);
  stream.push({ kind: 'event', event });
};

/** Runs one definition, writing down what it threw. */
const defineIn = (state: FenceProbeState, define: () => unknown): void => {
  try {
    define();
  } catch (error) {
    state.errors.push(error);
  }
};

/**
 * The probe: `tags` are registered at activation, as `[tag, elementTag]`;
 * `elements` lists every element tag it defines (the registered ones included).
 */
export const fenceProbe = (
  tags: readonly (readonly [string, string])[],
  elements: readonly string[] = tags.map(([, element]) => element),
): { probe: Probe; state: FenceProbeState } => {
  const state: FenceProbeState = {
    created: [],
    connected: [],
    disposed: [],
    registrations: new Map(),
    errors: [],
    register(tag, elementTag) {
      try {
        const views = state.views;
        if (views === undefined) throw new Error('the probe is not active');
        state.registrations.set(
          tag,
          views.registerFenceRenderer({ tag, elementTag }),
        );
      } catch (error) {
        state.errors.push(error);
      }
    },
  };
  const probe: Probe = {
    requires: [
      'chat.views/v1@^1.1.0',
      'ui/v1@^1.0.0',
      'chat.lexical/v1@^1.0.0',
    ],
    activate: ({ services }: ClientContext) => {
      const ui = services.use(UiV1);
      const Base = globalThis.HTMLElement;
      for (const tag of elements) {
        defineIn(state, () =>
          ui.define(
            tag,
            class extends Base {
              view: unknown;
              constructor() {
                super();
                state.created.push(this as unknown as FenceElement);
              }
              connectedCallback() {
                state.connected.push({
                  element: this as unknown as FenceElement,
                  view: this.view,
                });
                if (this.querySelector('input') === null)
                  this.append(this.ownerDocument.createElement('input'));
              }
              dispose() {
                state.disposed.push(this as unknown as FenceElement);
              }
            },
          ),
        );
      }
      services.use(ChatLexicalV1).registerExtension(
        defineExtension({
          name: 'test/fence-editor',
          register: (editor) => {
            // StrictMode builds the editor twice; the first one is kept.
            state.editor ??= editor;
            return () => {};
          },
        }),
      );
      state.views = services.use(ChatViewsV1);
      for (const [tag, elementTag] of tags) state.register(tag, elementTag);
    },
  };
  return { probe, state };
};

/** The conversation's whole text, as the editor's nodes give it. */
export const conversationText = (state: FenceProbeState): string => {
  const editor = state.editor;
  if (editor === undefined) throw new Error('no conversation editor');
  return editor.getEditorState().read(() => $getRoot().getTextContent());
};

/** The probe activated, and every definition and registration it made held. */
export const assertReady = (state: FenceProbeState): void => {
  if (state.errors.length > 0)
    throw new Error(
      `the probe's registrations failed: ${state.errors.map(String).join('; ')}`,
    );
  if (state.views === undefined) throw new Error('the probe did not activate');
};
