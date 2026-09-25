import { Conversation } from '@/components/organisms/conversation';
import { composePrompt } from '@/domain/comments';
import type {
  Project,
  Thread,
  ThreadEvent,
  ThreadUpdate,
  WorkspaceApi,
} from '@/domain/workspace';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * The conversation surface alone, on a stub host.
 *
 * The renderer's test target is DOM-free by design, so every rule about the
 * Lexical document — where the caret may stand, what a sealed turn refuses, which
 * selection offers a comment, what a closed fold holds — has no other runnable
 * proof, and has twice been checked only by hand with a harness that was thrown
 * away afterwards. This page is that proof kept: it mounts `Conversation` against a
 * scripted log, writes what it was given and what the surface asked for into
 * `window.__harness`, and is what `conversation-drive.mjs` drives and what a person
 * opens in a browser.
 *
 * Nothing imports it. It is the entry `tools/conversation-harness.html` loads, and
 * `webpack.config.js` adds it — with the `tools` directory the dev server serves —
 * only outside a production build, so the packaged renderer is untouched by it.
 */

/** The Project the page's Thread belongs to. Nothing here is persisted. */
const PROJECT: Project = {
  id: 'project-harness',
  name: 'harness',
  state: 'ready',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

const THREAD: Thread = {
  id: 'thread-harness',
  name: 'Conversation harness',
  projectId: PROJECT.id,
  state: 'ready',
  createdAt: PROJECT.createdAt,
  updatedAt: PROJECT.updatedAt,
};

/** The log's clock: one second per sequence, so the script reads in its own order. */
const at = (sequence: number): string =>
  new Date(Date.UTC(2025, 0, 1, 0, 0, sequence)).toISOString();

/** One event of the log, in the shape `threads.watch` delivers. */
const entry = (
  promptId: string,
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): ThreadEvent => ({
  createdAt: at(sequence),
  event: { type, ...payload },
  projectId: PROJECT.id,
  promptId,
  sequence,
  threadId: THREAD.id,
  type,
});

/**
 * The first answer, carrying every block the reading has: a heading, a list, a
 * fenced code block and a link, so one turn proves the markdown path end to end.
 * Its first list item is what the second prompt comments on.
 */
const FIRST_ANSWER = [
  '## What the projector does',
  '',
  "It folds the Thread's events into the turns the surface reads, and it is the",
  'only place that does:',
  '',
  '- one turn per `promptId`, ordered by sequence;',
  '- reasoning, text and tool calls as separate parts;',
  '- a rewind drops the range it discarded.',
  '',
  '```ts',
  'export const projectEvents = (current, incoming) => …',
  '```',
  '',
  'See [the renderer notes](../README.md) for the rest.',
].join('\n');

/** The answer being answered — the one a comment may be made on. */
const SECOND_ANSWER = [
  'The ordering lives in `domain/projector.ts`, which sorts the events by',
  '`sequence` before it folds them.',
  '',
  'That is also what lets a prompt be rewritten where it stands: everything a',
  'rewind discarded is already gone from the log before the turns are derived.',
].join('\n');

/**
 * The second prompt as the composer sends one: the comment a person made on the
 * answer above, above the request it travels with. It is written by the same
 * `composePrompt` the composer uses, so the log carries a prompt the surface reads
 * back into a card rather than a copy of the format that could drift from it.
 */
const COMPOSED_PROMPT = composePrompt(
  [
    {
      id: 'comment:1',
      quote: 'one turn per `promptId`, ordered by sequence',
      body: 'Where does that ordering live?',
    },
  ],
  'Answer what I asked about the ordering.',
);

/**
 * The log the page is given, small enough to read in one screen: a reasoning run,
 * a tool call and a markdown answer, then a prompt that carried a comment. Between
 * them they are every block the surface draws — both folds, the prose, the comment
 * card and the composer.
 *
 * A finished prompt states its whole text, because that is what the projector keeps
 * as the answer once the prompt is over.
 */
const LOG: readonly ThreadEvent[] = [
  entry('prompt-1', 1, 'prompt.accepted', {
    source: { kind: 'user' },
    text: 'What does the projector do?',
  }),
  entry('prompt-1', 2, 'reasoning.delta', {
    delta: 'The question is about `domain/projector.ts`, so read that first.\n',
  }),
  entry('prompt-1', 3, 'tool.started', {
    call: {
      id: 'call-1',
      name: 'read',
      payload: { path: 'src/domain/projector.ts' },
    },
  }),
  entry('prompt-1', 4, 'tool.finished', {
    call: { id: 'call-1' },
    record: { output: 'export const projectEvents = (current, incoming) => …' },
  }),
  entry('prompt-1', 5, 'text.delta', { delta: FIRST_ANSWER }),
  entry('prompt-1', 6, 'prompt.finished', {
    status: 'completed',
    text: FIRST_ANSWER,
  }),
  entry('prompt-2', 7, 'prompt.accepted', {
    source: { kind: 'user' },
    text: COMPOSED_PROMPT,
  }),
  entry('prompt-2', 8, 'text.delta', { delta: SECOND_ANSWER }),
  entry('prompt-2', 9, 'prompt.finished', {
    status: 'completed',
    text: SECOND_ANSWER,
  }),
];

/**
 * What the stub answers a prompt the page sends with. It is short and the same
 * every time, so what the page asked for stays easy to tell from what came back.
 */
const REPLY =
  'The harness answers every prompt the same way, so what was sent stays easy to find.';

/** What the page was given and what it asked the host for. */
type Harness = {
  /** The scripted log the page was given. */
  readonly log: readonly ThreadEvent[];
  /** Every prompt the surface sent, in the order it sent them, as composed. */
  readonly sent: readonly string[];
  /** Every prompt the surface rewound, with the prompt it replaced. */
  readonly rewound: readonly {
    readonly promptId: string;
    readonly prompt: string;
  }[];
};

declare global {
  interface Window {
    /** Read by `conversation-drive.mjs`, which is why the page writes it at all. */
    readonly __harness: Harness;
  }
}

/**
 * Every host call the conversation surface does not make. A harness that answered
 * one with a plausible nothing would hide the day a surface starts making it, so
 * each one throws and names itself instead.
 */
const unscripted = (call: string): never => {
  throw new Error(`The conversation harness does not script ${call}.`);
};

/** The subscriptions `threads.watch` has opened, in the order they arrived. */
const listeners = new Set<(update: ThreadUpdate) => void>();

const harness: {
  log: readonly ThreadEvent[];
  sent: string[];
  rewound: { promptId: string; prompt: string }[];
} = { log: LOG, rewound: [], sent: [] };

/** The next sequence the page's own events take; the scripted log ends below it. */
let sequence = LOG.at(-1)?.sequence ?? 0;

/** The last sequence each prompt reached, so a rewind knows where its range ended. */
const ends = new Map<string, number>(
  LOG.map((event) => [event.promptId, event.sequence]),
);

/** Appends one event to the log the surface is subscribed to. */
const emit = (
  promptId: string,
  type: string,
  payload: Record<string, unknown> = {},
): void => {
  sequence += 1;
  ends.set(promptId, sequence);
  const event = entry(promptId, sequence, type, payload);
  for (const listener of listeners) listener({ kind: 'event', event });
};

/**
 * The short answer the stub streams for one prompt: reasoning, then prose, then the
 * finished prompt that states the same prose as the answer it settled on.
 */
const answer = (promptId: string): void => {
  emit(promptId, 'reasoning.delta', { delta: 'Reading the request.\n' });
  emit(promptId, 'text.delta', { delta: REPLY });
  emit(promptId, 'prompt.finished', { status: 'completed', text: REPLY });
};

/**
 * The host the page runs against. Only the conversation's own three calls are
 * answered: `threads.watch` replays the scripted log from the start — the harness
 * keeps no cursor, because there is nothing behind it to resume from — and
 * `threads.prompt` and `threads.rewind` record what was asked and stream an answer
 * back through the same subscription a real host would use.
 */
const api: WorkspaceApi = {
  connection: {
    status: () => 'connected',
    subscribe: () => () => undefined,
  },
  config: {
    get: () => unscripted('config.get'),
    update: () => unscripted('config.update'),
  },
  projects: {
    create: () => unscripted('projects.create'),
    delete: () => unscripted('projects.delete'),
    diff: () => unscripted('projects.diff'),
    file: () => unscripted('projects.file'),
    files: () => unscripted('projects.files'),
    list: () => unscripted('projects.list'),
    rename: () => unscripted('projects.rename'),
    setColor: () => unscripted('projects.setColor'),
    terminate: () => unscripted('projects.terminate'),
    watch: () => unscripted('projects.watch'),
  },
  threads: {
    create: () => unscripted('threads.create'),
    delete: () => unscripted('threads.delete'),
    get: () => unscripted('threads.get'),
    list: () => unscripted('threads.list'),
    prompt: (_id, prompt) => {
      harness.sent.push(prompt);
      const promptId = `sent:${String(harness.sent.length)}`;
      emit(promptId, 'prompt.accepted', {
        source: { kind: 'user' },
        text: prompt,
      });
      answer(promptId);
      return Promise.resolve({ promptId });
    },
    rename: () => unscripted('threads.rename'),
    rewind: (_id, promptId, prompt) => {
      harness.rewound.push({ prompt, promptId });
      // The host discards what followed the prompt being replaced, and the marker
      // says which sequence survived: the range strictly above it is dropped, and
      // the replacement prompt's events are numbered above the marker.
      const discarded = ends.get(promptId) ?? 0;
      const replacement = `rewound:${String(harness.rewound.length)}`;
      emit(promptId, 'history.truncated', { afterSequence: discarded });
      emit(replacement, 'prompt.accepted', {
        source: { kind: 'user' },
        text: prompt,
      });
      answer(replacement);
      return Promise.resolve({ promptId: replacement });
    },
    terminate: () => unscripted('threads.terminate'),
    watch: (_id, _afterSequence, listener) => {
      listeners.add(listener);
      listener({
        kind: 'snapshot',
        snapshot: {
          events: LOG,
          project: PROJECT,
          projectId: PROJECT.id,
          thread: THREAD,
          threadId: THREAD.id,
        },
      });
      return () => {
        listeners.delete(listener);
      };
    },
  },
};

// The host's preload defines `doric` as a read-only property, so the stub replaces
// the property rather than assigning to it; `__harness` is declared read-only for
// the same reason a driver should read it and never write it.
Object.defineProperty(window, 'doric', { configurable: true, value: api });
Object.defineProperty(window, '__harness', {
  configurable: true,
  value: harness,
});

const root = document.getElementById('root');
if (root === null) {
  throw new Error('The harness page has no #root to render the surface into.');
}

createRoot(root).render(
  <StrictMode>
    {/*
      The surface is a column that scrolls with the composer last, so it needs the
      height of the page: without one the scroll area would be the height of its own
      content and the composer would sit below the fold.
    */}
    <div className="flex h-svh min-h-0 flex-col bg-background">
      <Conversation thread={THREAD} />
    </div>
  </StrictMode>,
);
