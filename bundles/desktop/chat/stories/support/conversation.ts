// The conversation's story data and the host the conversation's stories run
// against: one realistic Thread whose durable log covers every kind of turn
// the transcript draws, small logs for the node stories, and the window state
// the conversation reads (the opened-Thread store, the queue query, the
// composer's stack and draft, the sidebar tree, the live terminals and the
// queue edit). Every shape is the host's, so the projection, the stores and
// the nodes read exactly what a window fed by the host would.
//
// Nothing here talks to a host: `installStoryHost` hands the chat a set of
// fake activation services that answer from these fixtures and refuse every
// write, so a click in a story never leaves the page.

import { QueryClient } from '@tanstack/react-query';

import type {
  ChatTerminalsApi,
  Terminal,
} from '../../src/client/api/terminals-contract.js';
import type { LayoutWorkspace } from '../../src/client/api/workspace-contract.js';
import { READER_NAME } from '../../src/client/domain/conversation-authors.js';
import {
  emptyProjection,
  type Projection,
  projectEvents,
  type Turn,
} from '../../src/client/domain/projector.js';
import type { QueueItem, ThreadQueue } from '../../src/client/domain/queue.js';
import { emptyThreadChats } from '../../src/client/domain/thread-chats.js';
import type { Thread, ThreadEvent } from '../../src/client/domain/workspace.js';
import { queryKeys } from '../../src/client/queries/keys.js';
import {
  initChat,
  setWorkspace,
} from '../../src/client/services/chat-services.js';
import { setTerminalServiceApi } from '../../src/client/stores/live-terminals.js';
import {
  type QueueEdit,
  queueEditStore,
} from '../../src/client/stores/queue-edit.js';
import { threadChatsStore } from '../../src/client/stores/thread-chats.js';
import type {
  ComposerAddInput,
  ComposerItem,
} from '../../src/contracts/index.js';
import {
  checkoutTarget,
  editArgs,
  editResult,
  failingTests,
  logOf,
  passingTests,
  projectId,
  promptIdOf,
  queueItem,
  stackItem,
  terminalArgs,
  terminalResult,
  testCommand,
  writeArgs,
} from './fixtures.js';

export { projectId, promptIdOf };

// Threads ------------------------------------------------------------------

/** The Threads the conversation's stories open. */
export const storyThreadIds = {
  redesign: '3a7e1c90-5b2d-4f6e-8a1c-0d9e8f7a6b5c',
  child: '4b8f2da1-6c3e-4a7f-9b2d-1e0f9a8b7c6d',
  parent: '5c903eb2-7d4f-4b80-8c3e-2f1a0b9c8d7e',
  nodes: '6da14fc3-8e50-4c91-9d4f-3a2b1c0d9e8f',
  idle: '7eb250d4-9f61-4da2-8e50-4b3c2d1e0f9a',
} as const;

const threadBase = {
  projectId,
  cwd: '/workspace/storefront',
  cwdRepo: 'github' as const,
  createdAt: '2026-10-16T08:00:00.000Z',
  updatedAt: '2026-10-16T08:58:00.000Z',
};

/** The prompt the full Thread is running. */
export const runningPromptId = promptIdOf(1006);

/** One realistic Thread, with the agent running its latest prompt. */
export const redesignThread: Thread = {
  ...threadBase,
  id: storyThreadIds.redesign,
  name: 'Ship the checkout redesign',
  state: 'running',
  activePromptId: runningPromptId,
  executionStartedAt: '2026-10-16T08:57:20.000Z',
};

/** The subthread the full Thread delegated the contrast audit to. */
export const childThread: Thread = {
  ...threadBase,
  id: storyThreadIds.child,
  name: 'Check color contrast',
  parentThreadId: storyThreadIds.redesign,
  state: 'idle',
};

/** The Thread that hands the node stories' child its instruction. */
export const parentThread: Thread = {
  ...threadBase,
  id: storyThreadIds.parent,
  name: 'Plan the storefront release',
  state: 'idle',
};

/** The Thread every node story stands in: its blocks only read its ids. */
export const nodesThread: Thread = {
  ...threadBase,
  id: storyThreadIds.nodes,
  name: 'Polish the checkout card',
  state: 'idle',
};

/** A Thread that ran nothing yet. */
export const idleThread: Thread = {
  ...threadBase,
  id: storyThreadIds.idle,
  name: 'New thread',
  state: 'idle',
};

/** The sidebar tree the stories' delegated rows name their senders from. */
export const workspaceThreads: readonly Thread[] = [
  redesignThread,
  childThread,
  parentThread,
  nodesThread,
  idleThread,
];

// The full Thread -----------------------------------------------------------

/** The agent's answer to the redesign: every markdown block the theme styles. */
export const redesignAnswer = [
  '## Checkout card',
  '',
  'The card now follows the **new layout**: the summary sits above the',
  'payment form, and the *Pay* button uses the `primary` token.',
  '',
  '- `src/components/Checkout.tsx`: the new grid and the lock icon',
  '- `src/components/CartSummary.tsx`: draws on `bg-card`',
  '- `src/styles/checkout.css`: removed, the utilities cover it',
  '',
  '| Check | Before | After |',
  '| --- | --- | --- |',
  '| Contrast of the Pay label | 1.2:1 | 7.4:1 |',
  '| Checkout tests | 9 of 10 | 10 of 10 |',
  '',
  '```tsx',
  '<Button className="bg-primary text-primary-foreground">',
  '  <LockIcon data-icon="inline-start" />',
  '  Pay {formatTotal(total)}',
  '</Button>',
  '```',
  '',
  '> The old `checkout.css` overrides were the reason dark mode broke.',
].join('\n');

/**
 * The agent's answer to a prompt: streamed, then the finished text the host
 * closes the run with, which is what the projection keeps.
 */
const answer = (
  log: ReturnType<typeof logOf>,
  promptId: string,
  text: string,
): void => {
  log.text(promptId, text);
  log.finish(promptId, text);
};

/** A reply to a comment, as `comment_reply` writes it. */
const reply = (
  log: ReturnType<typeof logOf>,
  promptId: string,
  input: {
    readonly id: string;
    readonly callId: string;
    readonly inReplyTo: string;
    readonly line: number;
    readonly label?: string;
    readonly text: string;
  },
) => {
  const call = {
    id: input.callId,
    name: 'comment_reply',
    payload: { commentId: input.inReplyTo, text: input.text },
  };
  log.push(promptId, { type: 'tool.started', call });
  log.push(promptId, {
    type: 'comments.added/v1',
    commentId: input.id,
    inReplyTo: input.inReplyTo,
    target: checkoutTarget(input.line, input.label),
    text: input.text,
    author: 'agent',
  });
  log.push(promptId, {
    type: 'tool.finished',
    call,
    record: { output: '{"ok":true}' },
  });
};

/** A comment the reader's send flushed below its prompt. */
const comment = (
  log: ReturnType<typeof logOf>,
  promptId: string,
  input: {
    readonly id: string;
    readonly line: number;
    readonly label?: string;
    readonly text: string;
  },
) =>
  log.push(promptId, {
    type: 'comments.added/v1',
    commentId: input.id,
    target: checkoutTarget(input.line, input.label),
    text: input.text,
    author: READER_NAME,
  });

/** The full Thread's command that is still running. */
export const liveCommand = 'npm run test:e2e -- checkout';

const redesignLog = () => {
  const log = logOf(storyThreadIds.redesign);

  // A burst of reasoning and tool calls, then the answer.
  const first = promptIdOf(1001);
  log.prompt(
    first,
    'Redesign the checkout card: the summary goes above the payment form, and the Pay button must stay readable in dark mode.',
  );
  log.thinking(
    first,
    'The reader wants a new layout and a dark-mode fix. I should read the checkout component, find every hard-coded color, then run the checkout tests.',
  );
  log.tool(
    first,
    'call-1',
    'read',
    { path: 'src/components/Checkout.tsx' },
    { output: 'export function Checkout({ total }: CheckoutProps) { … }' },
  );
  log.tool(
    first,
    'call-2',
    'grep',
    { pattern: 'bg-white', path: 'src' },
    {
      output:
        'src/components/Checkout.tsx:41\nsrc/components/CartSummary.tsx:18',
    },
  );
  log.thinking(
    first,
    'Two hard-coded backgrounds. The button gets the primary token, the summary the card token.',
  );
  log.tool(first, 'call-3', 'edit', JSON.parse(editArgs), {
    output: editResult,
  });
  log.tool(first, 'call-4', 'terminal', JSON.parse(terminalArgs(testCommand)), {
    output: terminalResult({ command: testCommand, stdout: passingTests }),
  });
  answer(log, first, redesignAnswer);

  // The reader's comments, flushed with the prompt, and the agent's replies.
  const second = promptIdOf(1002);
  log.prompt(second, 'Address my notes on the card.');
  comment(log, second, {
    id: 'comment-redesign-1',
    line: 42,
    text: 'The Pay button is too close to the total',
  });
  comment(log, second, {
    id: 'comment-redesign-2',
    line: 18,
    label: 'h2',
    text: 'Use the same heading size as the cart page',
  });
  reply(log, second, {
    id: 'comment-redesign-3',
    callId: 'call-5',
    inReplyTo: 'comment-redesign-1',
    line: 42,
    text: 'Added `gap-4` between the total and the button.',
  });
  log.push(second, {
    type: 'comments.resolved/v1',
    commentId: 'comment-redesign-1',
    resolved: true,
  });
  reply(log, second, {
    id: 'comment-redesign-4',
    callId: 'call-6',
    inReplyTo: 'comment-redesign-2',
    line: 18,
    label: 'h2',
    text: 'The cart page uses `text-lg`; should the checkout match it on mobile too?',
  });
  answer(
    log,
    second,
    'Both notes are addressed; one question is open on the heading.',
  );

  // A compaction, a failing run, a host stop and the resume that took it up.
  const third = promptIdOf(1003);
  log.prompt(third, 'Run the whole test suite and fix what fails.');
  log.push(third, { type: 'agent.started' });
  log.push(third, { type: 'compaction.started', trigger: 'automatic' });
  log.push(third, {
    type: 'compaction.finished',
    summaryId: 'summary-1',
    summary:
      '## Summary\n\n- The checkout card was redesigned (summary above the form).\n- The Pay button uses `bg-primary`; `CartSummary` uses `bg-card`.\n- One open question: the heading size on mobile.',
    condensedMessages: 18,
    tokensFreed: 42_150,
  });
  log.tool(third, 'call-7', 'terminal', JSON.parse(terminalArgs('npm test')), {
    output: terminalResult({
      command: 'npm test',
      stdout: passingTests.slice(0, 3),
      stderr: failingTests,
      exitCode: 1,
      durationMs: 8_420,
    }),
  });
  log.push(third, { type: 'prompt.paused', reason: 'host_stopped' });
  log.push(third, { type: 'prompt.resumed', attempt: 1 });
  log.push(third, { type: 'agent.started' });
  answer(
    log,
    third,
    'The failing test expected the old `bg-white` class. I updated the assertion to the primary token; the suite passes again.',
  );

  // A subthread's result arriving as input.
  const result = promptIdOf(1004);
  log.push(result, {
    type: 'prompt.accepted',
    text: [
      '# Delegated task result',
      `Thread: ${storyThreadIds.child}`,
      `Parent: ${storyThreadIds.redesign}`,
      `Prompt: ${promptIdOf(1100)}`,
      'Status: completed',
      '## Result',
      'Two pairs fail WCAG AA:',
      '',
      '- muted text on the card (3.9:1)',
      '- the disabled button label (2.8:1)',
    ].join('\n'),
    source: { kind: 'result', threadId: storyThreadIds.child },
  });
  answer(
    log,
    result,
    'The contrast audit found two failures; I raised the muted text to 4.6:1 and the disabled label to 4.5:1.',
  );

  // A prompt the provider failed.
  const failed = promptIdOf(1005);
  log.prompt(failed, 'Deploy the preview to staging.');
  log.push(failed, { type: 'agent.started' });
  log.push(failed, {
    type: 'agent.failed',
    error: {
      name: 'ProviderError',
      code: 'rate_limited',
      message:
        'The model provider is rate limiting requests. Try again in a minute.',
    },
  });
  log.push(failed, {
    type: 'prompt.finished',
    status: 'failed',
    text: '',
    source: { kind: 'user' },
  });

  // The prompt still running: a write, a live terminal and streaming text.
  log.prompt(runningPromptId, 'Add an order history page under /orders.');
  log.push(runningPromptId, { type: 'agent.started' });
  log.thinking(
    runningPromptId,
    'A route, a page and a paginated query. I will write the page first.',
  );
  log.tool(runningPromptId, 'call-8', 'write', JSON.parse(writeArgs), {
    output: JSON.stringify({ success: true }),
  });
  log.tool(
    runningPromptId,
    'call-9',
    'terminal',
    JSON.parse(terminalArgs(liveCommand)),
  );

  // Two prompts the reader queued behind it.
  for (const [n, text] of [
    [1007, 'Then add an empty state to the order history.'],
    [1008, 'Open a pull request when the tests pass.'],
  ] as const) {
    log.push(promptIdOf(n), {
      type: 'prompt.accepted',
      text,
      source: { kind: 'user' },
      queued: true,
    });
    log.push(promptIdOf(n), { type: 'prompt.queued' });
  }
  return log.events;
};

/** The full Thread's durable log, as the host replays it. */
export const redesignEvents: readonly ThreadEvent[] = redesignLog();

/** What the queue answers for the full Thread: the run and what follows it. */
export const redesignQueue: ThreadQueue = {
  revision: 7,
  paused: false,
  stopping: false,
  current: queueItem(1006, 'Add an order history page under /orders.'),
  items: [
    queueItem(1007, 'Then add an empty state to the order history.'),
    queueItem(1008, 'Open a pull request when the tests pass.'),
  ],
};

/** The draft the full Thread's composer holds: words and one comment. */
export const redesignDraft: {
  readonly text: string;
  readonly items: readonly ComposerItem[];
} = {
  text: 'Also check the layout at 375px.',
  items: [stackItem(3, 'The total should align with the button baseline', 44)],
};

/** The terminal the full Thread's running call drives. */
export const liveTerminal: Terminal = {
  id: 'terminal-e2e',
  projectId,
  threadId: storyThreadIds.redesign,
  origin: 'agent',
  command: liveCommand,
  cwd: '/workspace/storefront',
  startedAt: '2026-10-16T08:58:10.000Z',
  timeoutMs: 600_000,
  state: 'running',
  pty: false,
};

/** What the live terminal has printed so far. */
export const liveOutput = [
  '> storefront@2.4.0 test:e2e',
  '> playwright test checkout',
  '',
  'Running 6 tests using 3 workers',
  '  ✓ checkout › pays with a saved card (2.1s)',
  '  ✓ checkout › shows the summary above the form (1.4s)',
  '  ✓ checkout › keeps the Pay label readable in dark mode (1.7s)',
  '',
].join('\n');

// Node story logs -----------------------------------------------------------

/** One Thread's log as a story builds it. */
export type StoryLog = ReturnType<typeof logOf>;

/** A log of the node stories' Thread, projected the way the store does. */
export const projectLog = (
  build: (log: ReturnType<typeof logOf>) => void,
  threadId: string = storyThreadIds.nodes,
): Projection => {
  const log = logOf(threadId);
  build(log);
  return projectEvents(emptyProjection, log.events);
};

/** The turns one log projects into. */
export const turnsOfLog = (
  build: (log: ReturnType<typeof logOf>) => void,
  threadId?: string,
): readonly Turn[] => projectLog(build, threadId).turns;

/** The turns of one kind a log projects into. */
export const turnsOfType = <T extends Turn['type']>(
  type: T,
  build: (log: ReturnType<typeof logOf>) => void,
): readonly Extract<Turn, { type: T }>[] =>
  turnsOfLog(build).filter(
    (turn): turn is Extract<Turn, { type: T }> => turn.type === type,
  );

export {
  answer,
  checkoutTarget,
  comment as flushedComment,
  editArgs,
  editResult,
  failingTests,
  passingTests,
  queueItem,
  reply as commentReply,
  stackItem,
  terminalArgs,
  terminalResult,
  testCommand,
  writeArgs,
};

/** A long prompt, to see how a turn wraps. */
export const longPrompt = [
  'The checkout has grown three different ways of drawing a price: `formatTotal`, `Intl.NumberFormat` inline, and the old `currency()` helper from the legacy cart.',
  '',
  'Please consolidate them:',
  '',
  '1. keep `formatTotal` as the only helper, with the locale from the store',
  '2. replace every inline `Intl.NumberFormat` in `src/components`',
  '3. delete `currency()` and its tests',
  '',
  'Do not touch the admin package; it ships separately and has its own release.',
].join('\n');

// The window the stories run in -----------------------------------------------

type StoryServices = NonNullable<Parameters<typeof initChat>[0]>;

const refused = (): Promise<never> =>
  Promise.reject(new Error('Stories have no host.'));

/**
 * One fake contract: the members given, and every other member a write the
 * stories refuse.
 */
const fake = (members: Readonly<Record<string, unknown>>): object =>
  new Proxy(members, {
    get: (target, name) =>
      typeof name === 'string' && name in target ? target[name] : refused,
  });

const disposable = { dispose: () => undefined };

/** What one story's window holds. */
export interface StoryHost {
  /** Each Thread's queue, as `runtime.threads/v1.queue` answers. */
  readonly queues?: Readonly<Record<string, ThreadQueue>>;
  /** Each Thread's composer draft, as `chat.composer/v1` holds it. */
  readonly drafts?: Readonly<
    Record<
      string,
      { readonly text: string; readonly items: readonly ComposerItem[] }
    >
  >;
  /** The agent terminals the Project runs, with their output. */
  readonly terminals?: readonly {
    readonly terminal: Terminal;
    readonly output: string;
  }[];
}

/**
 * Hands the chat the activation services a story runs on: the connection is
 * up, the queue and the composer answer from the fixtures, and every other
 * call is refused. The sidebar tree and the live terminals are set too.
 */
export const installStoryHost = (host: StoryHost = {}): void => {
  const queues = host.queues ?? {};
  const drafts = host.drafts ?? {};
  const terminals = host.terminals ?? [];
  const draftOf = (threadId: string) =>
    drafts[threadId] ?? { text: '', items: [] };
  /** The ids the composer's stack hands the items a story adds. */
  let added = 0;
  const apis: Readonly<Record<string, object>> = {
    // A link to another Thread goes nowhere: the story has no router.
    'navigation/v1': fake({ navigate: () => Promise.resolve() }),
    'doric.connection/v1': fake({
      status: () => 'connected',
      subscribe: () => disposable,
    }),
    'runtime.threads/v1': fake({
      queue: (threadId: string) => {
        const queue = queues[threadId];
        return queue === undefined
          ? Promise.reject(new Error('The queue is unavailable.'))
          : Promise.resolve(queue);
      },
    }),
    'chat.composer/v1': fake({
      read: ({ threadId }: { readonly threadId: string }) =>
        Promise.resolve({ threadId, ...draftOf(threadId) }),
      watch: (
        threadId: string,
        listener: (item: {
          readonly kind: 'snapshot';
          readonly threadId: string;
          readonly text: string;
          readonly items: ComposerItem[];
        }) => void,
      ) => {
        const draft = draftOf(threadId);
        listener({
          kind: 'snapshot',
          threadId,
          text: draft.text,
          items: [...draft.items],
        });
        return disposable;
      },
      setText: () => Promise.resolve(),
      // A note written in place (a stack line, the inline comment entry) adds
      // its item on the first character: the composer answers with the item it
      // assigned an id to, and leaves the fixtures alone, so a story's draft
      // never outlives the story.
      addItem: (input: ComposerAddInput) => {
        added += 1;
        return Promise.resolve<ComposerItem>({
          id: input.id ?? `comment-story-${added}`,
          kind: input.kind,
          elementTag: input.elementTag,
          data: input.data,
          ...(input.author === undefined ? {} : { author: input.author }),
          note: input.note ?? '',
        });
      },
      updateNote: () => Promise.resolve(),
      removeItem: () => Promise.resolve(),
    }),
  };
  const services: StoryServices = {
    provide: () => disposable,
    use: ((contract: { readonly id: string }) =>
      apis[contract.id] ?? fake({})) as StoryServices['use'],
    whenAvailable: () => disposable,
  };
  initChat(services);

  const workspace: LayoutWorkspace = {
    thread: (threadId) =>
      workspaceThreads.find((thread) => thread.id === threadId),
    selectedThread: () => undefined,
    subscribe: () => disposable,
  };
  setWorkspace(workspace);

  const api: ChatTerminalsApi = {
    snapshot: (terminalId) => {
      const held = terminals.find(({ terminal }) => terminal.id === terminalId);
      return Promise.resolve(
        held === undefined
          ? undefined
          : {
              terminal: held.terminal,
              output: held.output,
              offset: held.output.length,
              truncated: false,
            },
      );
    },
    stop: () => Promise.resolve(false),
    watchProject: (id, listener) => {
      const next = typeof listener === 'function' ? listener : listener.next;
      next({
        kind: 'snapshot',
        projectId: id,
        terminals: terminals
          .map(({ terminal }) => terminal)
          .filter((terminal) => terminal.projectId === id),
      });
      return disposable;
    },
  };
  setTerminalServiceApi(api);
};

/**
 * Opens Threads in the store the conversation reads, each from its log, as
 * the store would after reading its history: no watch is opened, so nothing
 * replays over the fixtures.
 */
export const openThreads = (
  opened: readonly {
    readonly thread: Thread;
    readonly events: readonly ThreadEvent[];
  }[],
): void => {
  const chats = new Map(emptyThreadChats.chats);
  for (const { thread, events } of opened) {
    chats.set(thread.id, {
      id: thread.id,
      thread,
      projection: projectEvents(emptyProjection, events),
      error: undefined,
      sending: false,
      sendError: undefined,
      pending: undefined,
      subscribed: true,
    });
  }
  threadChatsStore.setState({
    chats: {
      chats,
      viewed: opened.map(({ thread }) => thread.id),
      deleted: new Set(),
    },
  });
};

/** Sets, or clears, the queued prompt a Thread's composer is editing. */
export const seedQueueEdit = (
  threadId: string,
  edit: QueueEdit | undefined,
): void => {
  queueEditStore.getState().set(threadId, edit);
};

/** The edit of a queued prompt, as the composer holds it while it is open. */
export const queueEditOf = (
  item: QueueItem,
  text: string,
  extra: Partial<QueueEdit> = {},
): QueueEdit => ({
  item,
  revision: item.revision ?? 1,
  stored: item.preview,
  original: item.preview,
  text,
  draft: {
    type: 'user-prompt-node',
    version: 1,
    children: [],
    direction: null,
    format: '',
    indent: 0,
  },
  saving: false,
  ...extra,
});

/**
 * A query client that holds each Thread's queue as already read: nothing
 * refetches on its own, as the chat's own client is configured.
 */
export const storyQueryClient = (
  host: Pick<StoryHost, 'queues'> = {},
): QueryClient => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
      mutations: { retry: false },
    },
  });
  for (const [threadId, queue] of Object.entries(host.queues ?? {}))
    client.setQueryData(queryKeys.threadQueue(threadId), queue);
  return client;
};
