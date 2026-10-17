// Doric data the chat's stories draw: a Project, its Threads, the durable
// events of their logs, their queues and the composer stacks they hold. The
// shapes are the host's (`runtime.threads/v1`, `chat.composer/v1`), so a story
// that seeds them sees exactly what a window fed by the host would.

import {
  emptyProjection,
  projectEvents,
  type Turn,
} from '../../src/client/domain/projector.js';
import type { QueueItem, ThreadQueue } from '../../src/client/domain/queue.js';
import type {
  Project,
  Thread,
  ThreadEvent,
} from '../../src/client/domain/workspace.js';
import type { ComposerItem } from '../../src/contracts/index.js';

export const projectId = '0d3c6f1e-6a52-4c8e-9b7a-2f1e4d5c6b7a';

export const project: Project = {
  id: projectId,
  name: 'storefront',
  color: 'blue',
  state: 'ready',
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-16T08:30:00.000Z',
};

/** The Threads every story draws, one per conversation state. */
export const threadIds = {
  conversation: '6b1f0c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
  running: '7c2a1d3f-4e5b-4c6d-9e7f-8091a2b3c4d5',
  queued: '8d3b2e4a-5f6c-4d7e-8f80-91a2b3c4d5e6',
  paused: '9e4c3f5b-6a7d-4e8f-9091-a2b3c4d5e6f7',
  comments: 'af5d4a6c-7b8e-4f90-81a2-b3c4d5e6f708',
  delegated: 'b06e5b7d-8c9f-4a01-92b3-c4d5e6f70819',
  empty: 'c17f6c8e-9da0-4b12-83c4-d5e6f708192a',
  child: 'd2807d9f-aeb1-4c23-94d5-e6f708192a3b',
  composerIdle: 'e3918ea0-bfc2-4d34-85e6-f708192a3b4c',
  composerEditing: 'f4a29fb1-c0d3-4e45-96f7-08192a3b4c5d',
  composerEditingRunning: '05b3a0c2-d1e4-4f56-8708-192a3b4c5d6e',
  composerStopping: '16c4b1d3-e2f5-4067-9819-2a3b4c5d6e7f',
  composerQueueError: '27d5c2e4-f306-4178-892a-3b4c5d6e7f80',
} as const;

const base = {
  projectId,
  cwd: '/workspace/storefront',
  cwdRepo: 'github' as const,
  createdAt: '2026-10-16T08:00:00.000Z',
  updatedAt: '2026-10-16T08:42:00.000Z',
};

/** A prompt id that is a valid UUID, numbered for reading. */
export const promptIdOf = (n: number): string =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const runningPromptId = promptIdOf(201);

export const threads: Readonly<Record<keyof typeof threadIds, Thread>> = {
  conversation: {
    ...base,
    id: threadIds.conversation,
    name: 'Fix checkout dark mode',
    state: 'idle',
    lastExecutionMs: 48_200,
  },
  running: {
    ...base,
    id: threadIds.running,
    name: 'Add order history page',
    state: 'running',
    activePromptId: runningPromptId,
    executionStartedAt: '2026-10-16T08:41:12.000Z',
  },
  queued: {
    ...base,
    id: threadIds.queued,
    name: 'Migrate tests to Vitest',
    state: 'idle',
  },
  paused: {
    ...base,
    id: threadIds.paused,
    name: 'Upgrade to React 19',
    state: 'idle',
  },
  comments: {
    ...base,
    id: threadIds.comments,
    name: 'Polish the checkout card',
    state: 'idle',
  },
  delegated: {
    ...base,
    id: threadIds.delegated,
    name: 'Audit accessibility',
    state: 'idle',
  },
  empty: {
    ...base,
    id: threadIds.empty,
    name: 'New thread',
    state: 'idle',
  },
  child: {
    ...base,
    id: threadIds.child,
    name: 'Check color contrast',
    parentThreadId: threadIds.delegated,
    state: 'idle',
  },
  composerIdle: {
    ...base,
    id: threadIds.composerIdle,
    name: 'Rename the cart store',
    state: 'idle',
  },
  composerEditing: {
    ...base,
    id: threadIds.composerEditing,
    name: 'Document the API client',
    state: 'idle',
  },
  composerEditingRunning: {
    ...base,
    id: threadIds.composerEditingRunning,
    name: 'Speed up the build',
    state: 'running',
    activePromptId: promptIdOf(901),
    executionStartedAt: '2026-10-16T08:40:00.000Z',
  },
  composerStopping: {
    ...base,
    id: threadIds.composerStopping,
    name: 'Fix the flaky e2e test',
    state: 'running',
    activePromptId: promptIdOf(911),
    executionStartedAt: '2026-10-16T08:39:00.000Z',
  },
  composerQueueError: {
    ...base,
    id: threadIds.composerQueueError,
    name: 'Bump dependencies',
    state: 'idle',
  },
};

// Events -------------------------------------------------------------------

/** Builds one Thread's log, numbering its events and their clock. */
export const logOf = (threadId: string) => {
  let sequence = 0;
  const events: ThreadEvent[] = [];
  const streamed = new Map<string, string>();
  const at = (n: number): string =>
    new Date(Date.UTC(2026, 9, 16, 8, 30, 0) + n * 4_000).toISOString();
  const push = (
    promptId: string,
    event: Readonly<Record<string, unknown> & { readonly type: string }>,
  ): void => {
    sequence += 1;
    events.push({
      projectId,
      threadId,
      promptId,
      sequence,
      type: event.type,
      event,
      createdAt: at(sequence),
    });
  };
  return {
    events,
    push,
    prompt: (promptId: string, text: string) =>
      push(promptId, {
        type: 'prompt.accepted',
        text,
        source: { kind: 'user' },
      }),
    thinking: (promptId: string, delta: string) =>
      push(promptId, { type: 'reasoning.delta', delta }),
    text: (promptId: string, delta: string) => {
      streamed.set(promptId, (streamed.get(promptId) ?? '') + delta);
      push(promptId, { type: 'text.delta', delta });
    },
    tool: (
      promptId: string,
      id: string,
      name: string,
      payload: unknown,
      outcome?:
        | { readonly output: string }
        | { readonly error: string }
        | undefined,
    ) => {
      push(promptId, {
        type: 'tool.started',
        call: { id, name, payload },
      });
      if (outcome === undefined) return;
      if ('output' in outcome)
        push(promptId, {
          type: 'tool.finished',
          call: { id, name },
          record: { output: outcome.output },
        });
      else
        push(promptId, {
          type: 'tool.failed',
          call: { id, name },
          error: { message: outcome.error },
        });
    },
    // The finished text is authoritative: it is the whole answer streamed.
    finish: (promptId: string, text = streamed.get(promptId) ?? '') =>
      push(promptId, {
        type: 'prompt.finished',
        status: 'completed',
        text,
        source: { kind: 'user' },
      }),
    sequence: () => sequence,
  };
};

// Tool calls ---------------------------------------------------------------

/** A terminal command's compact result, as `terminal.compact.v1` writes it. */
export const terminalResult = (input: {
  readonly command: string;
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly tail?: readonly string[];
  readonly omitted?: number;
  readonly exitCode?: number;
  readonly durationMs?: number;
}): string => {
  const stream = (
    head: readonly string[],
    tail: readonly string[] = [],
    omitted = 0,
  ) => ({
    bytes: [...head, ...tail].join('\n').length,
    lines: head.length + tail.length + omitted,
    head,
    tail,
    omitted_lines: omitted,
    omitted_bytes: omitted * 48,
    truncated: omitted > 0,
  });
  const exitCode = input.exitCode ?? 0;
  return JSON.stringify({
    schema: 'terminal.compact.v1',
    command: input.command,
    working_directory: '/workspace/storefront',
    exit_code: exitCode,
    duration_ms: input.durationMs ?? 2_340,
    termination_reason: 'exited',
    success: exitCode === 0,
    stdout: stream(input.stdout ?? [], input.tail, input.omitted),
    stderr: stream(input.stderr ?? []),
  });
};

export const testCommand = 'npm test -- --run src/checkout';

export const terminalArgs = (command: string, background = false): string =>
  JSON.stringify({
    command,
    working_directory: '/workspace/storefront',
    ...(background ? { background: true } : {}),
  });

export const passingTests = [
  ' RUN  v2.1.4 /workspace/storefront',
  '',
  ' ✓ src/checkout/checkout.test.tsx (6 tests) 182ms',
  ' ✓ src/checkout/total.test.ts (4 tests) 9ms',
  '',
  ' Test Files  2 passed (2)',
  '      Tests  10 passed (10)',
  '   Duration  1.94s',
];

export const failingTests = [
  ' FAIL  src/checkout/checkout.test.tsx > Checkout > uses the primary token',
  'AssertionError: expected "bg-white" to contain "bg-primary"',
  ' ❯ src/checkout/checkout.test.tsx:42:31',
];

/** The `edit` tool's call on the Checkout button. */
export const editArgs = JSON.stringify({
  path: 'src/components/Checkout.tsx',
  edits: [
    {
      oldText: '<Button className="bg-white text-black">',
      newText: '<Button className="bg-primary text-primary-foreground">',
    },
  ],
});

/** What `files`'s `edit` tool answers: the summary line and a numbered diff. */
export const editResult = JSON.stringify({
  success: true,
  first_changed_line: 41,
  diff: [
    'Edited src/components/Checkout.tsx (+2 -1)',
    '  39   return (',
    '  40     <footer className="flex justify-end gap-2">',
    '  41 -     <Button className="bg-white text-black">',
    '  41 +     <Button className="bg-primary text-primary-foreground">',
    '  42 +       <LockIcon data-icon="inline-start" />',
    '  43         Pay {formatTotal(total)}',
    '  44       </Button>',
  ].join('\n'),
});

/** A longer diff, past the sixteen lines the block shows before "Show more". */
export const longEditResult = JSON.stringify({
  success: true,
  diff: [
    'Edited src/stores/cart.ts (+12 -8)',
    ...Array.from({ length: 8 }, (_, index) => {
      const line = 10 + index;
      return `  ${line} -  ${['items', 'total', 'currency', 'discount', 'coupon', 'tax', 'shipping', 'updatedAt'][index]}: unknown;`;
    }),
    ...Array.from({ length: 12 }, (_, index) => {
      const line = 10 + index;
      return `  ${line} +  readonly ${['items', 'total', 'currency', 'discount', 'coupon', 'tax', 'shipping', 'updatedAt', 'customerId', 'notes', 'giftWrap', 'version'][index]}: ${index < 2 ? 'number' : 'string'};`;
    }),
    '  22   }',
  ].join('\n'),
});

/** The `write` tool creating a new file, while it is still running. */
export const writeArgs = JSON.stringify({
  path: 'src/pages/orders/OrderHistory.tsx',
  content: [
    "import { useOrders } from '../../hooks/use-orders';",
    '',
    'export function OrderHistory() {',
    '  const orders = useOrders();',
    '  return <OrderList orders={orders} />;',
    '}',
  ].join('\n'),
});

// Conversations -------------------------------------------------------------

const conversationLog = () => {
  const log = logOf(threadIds.conversation);
  const first = promptIdOf(101);
  log.prompt(
    first,
    'The Pay button in the checkout disappears in dark mode. Can you fix it?',
  );
  log.thinking(
    first,
    'The reader says the Pay button disappears in dark mode. The button likely uses a hard-coded white background instead of the theme token. I should look at Checkout.tsx first.',
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
  log.tool(first, 'call-3', 'edit', JSON.parse(editArgs), {
    output: editResult,
  });
  log.tool(first, 'call-4', 'terminal', JSON.parse(terminalArgs(testCommand)), {
    output: terminalResult({ command: testCommand, stdout: passingTests }),
  });
  log.text(
    first,
    'The button used a hard-coded `bg-white`, so in dark mode it blended into the card. ',
  );
  log.text(
    first,
    'It now uses the `primary` token:\n\n- `src/components/Checkout.tsx` — `bg-primary text-primary-foreground`, plus a lock icon\n- the checkout tests pass (10 of 10)\n\n`CartSummary.tsx` has the same pattern; want me to fix it too?',
  );
  log.finish(first);
  const second = promptIdOf(102);
  log.prompt(second, 'Yes, fix CartSummary as well.');
  log.tool(
    second,
    'call-5',
    'edit',
    {
      path: 'src/components/CartSummary.tsx',
      edits: [{ oldText: 'bg-white', newText: 'bg-card' }],
    },
    {
      output: JSON.stringify({
        success: true,
        diff: 'Edited src/components/CartSummary.tsx (+1 -1)\n  18 -    <section className="rounded-lg bg-white p-4">\n  18 +    <section className="rounded-lg bg-card p-4">',
      }),
    },
  );
  log.text(second, 'Done: `CartSummary` now draws on `bg-card`.');
  log.finish(second);
  return log.events;
};

const runningLog = () => {
  const log = logOf(threadIds.running);
  const first = promptIdOf(200);
  log.prompt(first, 'Where do we load the orders from?');
  log.text(
    first,
    'Orders come from `GET /api/orders`, wrapped by `useOrders` in `src/hooks/use-orders.ts`.',
  );
  log.finish(first);
  log.prompt(
    runningPromptId,
    'Add an order history page under /orders with pagination.',
  );
  log.thinking(
    runningPromptId,
    'I need a route, a page component and a paginated query. ',
  );
  log.tool(runningPromptId, 'call-1', 'write', JSON.parse(writeArgs), {
    output: JSON.stringify({ success: true }),
  });
  log.tool(
    runningPromptId,
    'call-2',
    'terminal',
    JSON.parse(terminalArgs('npm run typecheck')),
  );
  return log.events;
};

const queuedLog = () => {
  const log = logOf(threadIds.queued);
  const first = promptIdOf(300);
  log.prompt(first, 'Replace Jest with Vitest in the web package.');
  log.text(
    first,
    'Vitest is installed and `jest.config.js` is gone. 42 of 44 suites pass; two use `jest.mock` hoisting and need a manual look.',
  );
  log.finish(first);
  for (const [n, text] of [
    [301, 'Fix the two suites that still use jest.mock hoisting.'],
    [302, 'Then remove @types/jest from the devDependencies.'],
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

const pausedLog = () => {
  const log = logOf(threadIds.paused);
  const first = promptIdOf(400);
  log.prompt(first, 'Upgrade the app to React 19 and fix the type errors.');
  log.thinking(first, 'Start with the package versions, then run tsc. ');
  log.tool(
    first,
    'call-1',
    'terminal',
    JSON.parse(terminalArgs('npm install react@19 react-dom@19')),
    {
      output: terminalResult({
        command: 'npm install react@19 react-dom@19',
        stdout: ['added 2 packages, changed 3 packages in 6s'],
      }),
    },
  );
  log.push(first, { type: 'prompt.paused', reason: 'host_stopped' });
  const second = promptIdOf(401);
  log.prompt(second, 'Run the type check again.');
  log.push(second, {
    type: 'agent.failed',
    error: {
      name: 'ProviderError',
      code: 'rate_limited',
      message:
        'The model provider is rate limiting requests. Try again in a minute.',
    },
  });
  log.push(second, {
    type: 'prompt.finished',
    status: 'failed',
    text: '',
    source: { kind: 'user' },
  });
  return log.events;
};

/** The Checkout component's revision a comment is anchored on. */
export const checkoutTarget = (line: number, label = 'button') => ({
  kind: 'artifact',
  id: 'checkout-1',
  revision: 3,
  title: 'Checkout',
  source: 'src/components/Checkout.tsx',
  anchor: {
    form: 'element',
    selector: label,
    path: 'src/components/Checkout.tsx',
    line,
    label,
  },
});

const commentsLog = () => {
  const log = logOf(threadIds.comments);
  const first = promptIdOf(500);
  log.prompt(first, 'Tighten the checkout card using my notes.');
  log.push(first, {
    type: 'comments.added/v1',
    commentId: 'comment-1',
    target: checkoutTarget(42),
    text: 'The primary button disappears in dark mode',
  });
  log.push(first, {
    type: 'comments.added/v1',
    commentId: 'comment-2',
    target: checkoutTarget(18, 'h2'),
    text: 'Title and list need 8px between them',
  });
  log.text(first, 'I went through both notes.');
  log.push(first, {
    type: 'comments.added/v1',
    commentId: 'comment-3',
    inReplyTo: 'comment-1',
    target: checkoutTarget(42),
    text: 'Fixed: the button now uses the primary token.',
    author: 'agent',
  });
  log.push(first, {
    type: 'comments.resolved/v1',
    commentId: 'comment-1',
    resolved: true,
  });
  log.push(first, {
    type: 'comments.added/v1',
    commentId: 'comment-4',
    inReplyTo: 'comment-2',
    target: checkoutTarget(18, 'h2'),
    text: 'Should the gap be 8px on mobile too, or only from md up?',
    author: 'agent',
  });
  log.finish(first);
  return log.events;
};

const delegatedLog = () => {
  const log = logOf(threadIds.delegated);
  const first = promptIdOf(600);
  log.prompt(
    first,
    'Audit the storefront for accessibility issues. Delegate the contrast check.',
  );
  log.tool(
    first,
    'call-1',
    'delegate',
    { title: 'Check color contrast', task: 'Check WCAG AA contrast' },
    { output: `Started ${threadIds.child}` },
  );
  log.text(first, 'I started a subthread for the contrast check.');
  log.finish(first);
  const result = promptIdOf(601);
  log.push(result, {
    type: 'prompt.accepted',
    text: [
      '# Delegated task result',
      `Thread: ${threadIds.child}`,
      `Parent: ${threadIds.delegated}`,
      `Prompt: ${promptIdOf(700)}`,
      'Status: completed',
      '## Result',
      'Two pairs fail WCAG AA: muted text on the card (3.9:1) and the disabled button label (2.8:1).',
    ].join('\n'),
    source: { kind: 'result', threadId: threadIds.child },
  });
  log.text(
    result,
    'The subthread found two contrast failures; I will raise the muted text to 4.6:1.',
  );
  log.finish(result);
  return log.events;
};

/** Every Thread's durable log, as the host replays it. */
export const threadEvents: Readonly<Record<string, readonly ThreadEvent[]>> = {
  [threadIds.conversation]: conversationLog(),
  [threadIds.running]: runningLog(),
  [threadIds.queued]: queuedLog(),
  [threadIds.paused]: pausedLog(),
  [threadIds.comments]: commentsLog(),
  [threadIds.delegated]: delegatedLog(),
};

/** The turns the conversation projects from one Thread's log. */
export const turnsOf = (threadId: string): readonly Turn[] =>
  projectEvents(emptyProjection, threadEvents[threadId] ?? []).turns;

// Queues -------------------------------------------------------------------

export const emptyQueue: ThreadQueue = {
  revision: 1,
  paused: false,
  stopping: false,
  items: [],
};

export const queueItem = (
  n: number,
  preview: string,
  source: QueueItem['source'] = { kind: 'user' },
  label = '',
): QueueItem => ({
  promptId: promptIdOf(n),
  source,
  label,
  preview,
  acceptedAt: '2026-10-16T08:41:00.000Z',
  editable: source.kind === 'user',
  revision: 1,
});

export const queuedItems: readonly QueueItem[] = [
  queueItem(301, 'Fix the two suites that still use jest.mock hoisting.'),
  queueItem(302, 'Then remove @types/jest from the devDependencies.'),
];

/** Every Thread's queue, as `runtime.threads/v1.queue` answers. */
export const threadQueues: Readonly<Record<string, ThreadQueue>> = {
  [threadIds.queued]: {
    revision: 4,
    paused: true,
    stopping: false,
    items: queuedItems,
  },
  [threadIds.composerEditing]: {
    revision: 2,
    paused: false,
    stopping: false,
    items: [queueItem(801, 'Document the retry options of the API client.')],
  },
  [threadIds.composerEditingRunning]: {
    revision: 3,
    paused: false,
    stopping: false,
    current: queueItem(901, 'Profile the production build.'),
    items: [queueItem(902, 'Cache the TypeScript build info in CI.')],
  },
  [threadIds.composerStopping]: {
    revision: 5,
    paused: false,
    stopping: true,
    current: queueItem(911, 'Make the checkout e2e test deterministic.'),
    items: [],
  },
  [threadIds.composerQueueError]: {
    revision: 1,
    paused: true,
    stopping: false,
    items: [queueItem(921, 'Bump every minor version and run the tests.')],
  },
};

// Composer stacks ----------------------------------------------------------

/** One comment drafted on the stack, as `chat.composer/v1` holds it. */
export const stackItem = (
  n: number,
  note: string,
  line: number,
  label = 'button',
): ComposerItem => ({
  id: `comment-draft-${n}`,
  kind: 'papercraft.comment',
  elementTag: 'chat-comment-line',
  data: { target: checkoutTarget(line, label), pin: n },
  note,
});

/** Every Thread's draft, as `chat.composer/v1.read` answers. */
export const threadDrafts: Readonly<
  Record<
    string,
    { readonly text: string; readonly items: readonly ComposerItem[] }
  >
> = {
  [threadIds.comments]: {
    text: '',
    items: [
      stackItem(3, 'The total should align with the button baseline', 44),
      stackItem(4, '', 12, 'img'),
    ],
  },
};
