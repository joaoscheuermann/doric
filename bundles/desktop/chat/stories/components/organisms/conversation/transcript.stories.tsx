// The conversation's transcript drawn by its own blocks, seeded into the story
// editor (`stories/support/editor.tsx`) instead of rendered through the
// conversation component: no scroll column and no nav rail, so every node the
// transcript draws sits in the page at once. The component stories in
// `index.stories.tsx` keep the scroll column, and the per-node stories under
// `nodes/` stay the reference for the interaction states of one node.
// `FullConversation` is one whole Thread; `TurnsOverview` groups one correct
// example of every kind of turn under its own caption.

import { $createLineBreakNode, $createTextNode, $getRoot } from 'lexical';

import { $createAttachmentImageNode } from '../../../../src/client/components/organisms/conversation/nodes/attachment-image-node.js';
import {
  $createChatBlockNode,
  type DrawnBlock,
} from '../../../../src/client/components/organisms/conversation/nodes/chat-block-node.js';
import { EditQueuePrompt } from '../../../../src/client/components/organisms/conversation/plugins/edit-queue-prompt.js';
import { GENERIC_BLOCK_TYPE } from '../../../../src/client/domain/external-blocks.js';
import type {
  Turn,
  UserTurn,
} from '../../../../src/client/domain/projector.js';
import type { ThreadQueue } from '../../../../src/client/domain/queue.js';
import { GENERIC_BLOCK_TAG } from '../../../../src/client/services/views.js';
import {
  answer,
  childThread,
  commentReply,
  editArgs,
  editResult,
  flushedComment,
  longPrompt,
  nodesThread,
  parentThread,
  projectLog,
  promptIdOf,
  queueEditOf,
  queueItem,
  redesignAnswer,
  stackItem,
  terminalArgs,
  terminalResult,
  testCommand,
  turnsOfLog,
  turnsOfType,
  writeArgs,
} from '../../../support/conversation.js';
import {
  $appendPromptTail,
  $appendTurns,
  $createSectionCaptionNode,
  ConversationEditor,
  TurnsEditor,
} from '../../../support/editor.js';
import {
  backgroundResult,
  failingTests,
  passingTests,
} from '../../../support/fixtures.js';

// `layout: 'padded'`: the transcript is a page, not a card — the preview lays
// it out at the canvas's width, which is the pane the column centres itself in.
// `centered` (the default) hugs the content, and a hugged pane has no width for
// the column to take nor gutter for a turn's mark to hang in.
export default {
  title: 'Chat/Organisms/Conversation transcript',
  parameters: { layout: 'padded' },
};

// Fixtures ------------------------------------------------------------------

/** A block another bundle's projector made, drawn by `<chat-block>`. */
const previewBlock = (promptId: string): DrawnBlock => ({
  tag: GENERIC_BLOCK_TAG,
  block: {
    id: 'block-preview-1',
    type: GENERIC_BLOCK_TYPE,
    promptId,
    sequence: 3,
    data: {
      eventType: 'deploy.preview/v1',
      createdAt: '2026-10-16T08:44:12.000Z',
      payload: {
        environment: 'staging',
        url: 'https://storefront-pr-212.preview.example.dev',
        commit: '9c1e4b7',
        status: 'ready',
      },
    },
    actions: [],
  },
});

/** A block whose type no renderer claims, with its own data shape. */
const unknownBlock = (promptId: string): DrawnBlock => ({
  tag: GENERIC_BLOCK_TAG,
  block: {
    id: 'block-lint-1',
    type: 'lint.report',
    promptId,
    sequence: 4,
    data: { errors: 0, warnings: 3, files: ['src/stores/cart.ts'] },
    actions: [],
  },
});

const blocksOf = (
  ...drawn: readonly DrawnBlock[]
): ReadonlyMap<string, DrawnBlock> =>
  new Map(drawn.map((drawn) => [drawn.block.id, drawn]));

const reasoning =
  'The reader says the Pay button disappears in dark mode. The button likely uses a hard-coded white background instead of the theme token, so I should read `Checkout.tsx` first and then grep for other hard-coded backgrounds.';

const summary = [
  '## Summary',
  '',
  '- The checkout card was redesigned: the summary sits above the form.',
  '- The Pay button uses `bg-primary`; `CartSummary` uses `bg-card`.',
  '- Open question: the heading size on mobile.',
].join('\n');

const longAnswer = Array.from(
  { length: 6 },
  (_, index) =>
    `${index + 1}. \`formatTotal\` reads the locale from the store, so a price drawn in the cart, the checkout and the order history uses the same separators, currency symbol and rounding, and \`src/legacy/currency.ts\` can go once nothing imports it.`,
).join('\n\n');

const failingError = {
  name: 'ProviderError',
  code: 'rate_limited',
  message:
    'The model provider is rate limiting requests. Try again in a minute.',
};

const resumeError = {
  name: 'ResumeError',
  code: 'resume_exhausted',
  message:
    'The prompt was interrupted three times and will not be resumed automatically.',
};

// Full conversation ---------------------------------------------------------

const fullProjection = (() => {
  const first = promptIdOf(4001);
  return projectLog((log) => {
    log.prompt(
      first,
      'Redesign the checkout card: the summary goes above the payment form, and the Pay button must stay readable in dark mode.',
    );
    flushedComment(log, first, {
      id: 'comment-full-1',
      line: 42,
      text: 'The Pay button is too close to the total',
    });
    flushedComment(log, first, {
      id: 'comment-full-2',
      line: 18,
      label: 'h2',
      text: 'Use the same heading size as the cart page',
    });
    commentReply(log, first, {
      id: 'comment-full-3',
      callId: 'call-1',
      inReplyTo: 'comment-full-1',
      line: 42,
      text: 'Added `gap-4` between the total and the button.',
    });
    // A delegation the agent made: the call handed a task to a Thread of its
    // own, and the finished result names the child the header links.
    log.tool(
      first,
      'call-spawn-1',
      'thread-spawn',
      {
        prompt:
          'Audit the muted text and the disabled button label against WCAG AA on every card.',
        title: 'contrast audit',
      },
      {
        output: JSON.stringify({
          threadId: childThread.id,
          promptId: promptIdOf(4099),
        }),
      },
    );
    answer(log, first, redesignAnswer);

    const compacted = promptIdOf(4002);
    log.prompt(compacted, 'Run the whole test suite and fix what fails.');
    log.push(compacted, { type: 'agent.started' });
    // A compaction happens inside a run, never straight after the prompt: the
    // agent has written something, the history is condensed, and the same run
    // goes on with its next answer.
    log.text(compacted, 'I will run the suite, then work through what fails.');
    log.push(compacted, { type: 'compaction.started', trigger: 'automatic' });
    log.push(compacted, {
      type: 'compaction.finished',
      summaryId: 'summary-full-1',
      summary,
      condensedMessages: 18,
      tokensFreed: 42_150,
    });
    answer(
      log,
      compacted,
      'The failing test expected the old `bg-white` class. I updated the assertion to the primary token; the suite passes again.',
    );

    const delegated = promptIdOf(4003);
    log.push(delegated, {
      type: 'prompt.accepted',
      text: [
        '# Delegated task result',
        `Thread: ${childThread.id}`,
        `Parent: ${nodesThread.id}`,
        `Prompt: ${promptIdOf(4099)}`,
        'Status: completed',
        '## Result',
        'Two pairs fail WCAG AA:',
        '',
        '- muted text on the card (3.9:1)',
        '- the disabled button label (2.8:1)',
      ].join('\n'),
      source: { kind: 'result', threadId: childThread.id },
    });
    answer(
      log,
      delegated,
      'The contrast audit found two failures; I raised the muted text to 4.6:1 and the disabled label to 4.5:1.',
    );

    const terminalId = 'terminal-full';
    const background = promptIdOf(4004);
    log.push(background, {
      type: 'prompt.accepted',
      text: backgroundResult({
        terminalId,
        promptId: promptIdOf(4000),
        command: testCommand,
        stdout: passingTests.join('\n'),
        durationMs: 1_940,
      }),
      source: { kind: 'terminal', terminalId },
    });
    answer(log, background, 'The checkout suite passes with the new tokens.');

    const resumed = promptIdOf(4005);
    log.prompt(resumed, 'Upgrade the app to React 19 and fix the type errors.');
    log.push(resumed, { type: 'agent.started' });
    log.push(resumed, { type: 'prompt.paused', reason: 'host_stopped' });
    log.push(resumed, { type: 'prompt.resumed', attempt: 1 });
    log.push(resumed, { type: 'agent.started' });
    answer(log, resumed, 'The types are clean; `tsc` reports no diagnostics.');

    const failed = promptIdOf(4006);
    log.prompt(failed, 'Deploy the preview to staging.');
    log.push(failed, { type: 'agent.started' });
    log.push(failed, { type: 'agent.failed', error: failingError });
    log.push(failed, {
      type: 'prompt.finished',
      status: 'failed',
      text: '',
      source: { kind: 'user' },
    });

    for (const [n, text] of [
      [4007, 'Then add an empty state to the order history.'],
      [4008, 'Open a pull request when the tests pass.'],
    ] as const) {
      log.push(promptIdOf(n), {
        type: 'prompt.accepted',
        text,
        source: { kind: 'user' },
        queued: true,
      });
      log.push(promptIdOf(n), { type: 'prompt.queued' });
    }

    const running = promptIdOf(4009);
    log.prompt(running, 'Add an order history page under /orders.');
    log.push(running, { type: 'agent.started' });
    log.thinking(
      running,
      'A route, a page and a paginated query. I will write the page first.',
    );
    log.tool(running, 'call-2', 'write', JSON.parse(writeArgs));
    // Still spawning: the child does not exist until the call returns.
    log.tool(running, 'call-spawn-2', 'thread-spawn', {
      prompt:
        'Sweep the order history page at 375px and report every row that overflows.',
      title: 'mobile sweep',
    });
    log.tool(
      running,
      'call-3',
      'terminal',
      JSON.parse(terminalArgs('npm run test:e2e -- checkout')),
    );
    log.text(running, 'The route is in place: `src/pages/orders/OrderHistory');
    log.text(running, '.tsx` reads the paginated query and renders the list.');
  });
})();

const fullHost = {
  queues: {
    [nodesThread.id]: {
      revision: 7,
      paused: false,
      stopping: false,
      current: queueItem(4009, 'Add an order history page under /orders.'),
      items: [
        queueItem(4007, 'Then add an empty state to the order history.'),
        queueItem(4008, 'Open a pull request when the tests pass.'),
      ],
    },
  },
  drafts: {
    [nodesThread.id]: {
      text: 'Also check the layout at 375px.',
      items: [
        stackItem(3, 'The total should align with the button baseline', 44),
      ],
    },
  },
} satisfies Parameters<typeof ConversationEditor>[0]['host'];

const fullBlocks = blocksOf(previewBlock(promptIdOf(4001)));

/** The whole Thread in one transcript, from its first prompt to the open one. */
export const FullConversation = {
  render: () => (
    <ConversationEditor
      host={fullHost}
      threads={fullProjection.threads}
      blocks={fullBlocks}
      seed={() => {
        const [first] = $appendTurns(fullProjection.turns);
        first
          ?.getNextSibling()
          ?.insertAfter(
            $createChatBlockNode(previewBlock(promptIdOf(4001)).block.id),
          );
        $appendPromptTail(nodesThread, 'Also check the layout at 375px.');
      }}
    />
  ),
};

// User turns ----------------------------------------------------------------

const userTurns = projectLog((log) => {
  log.prompt(
    promptIdOf(4101),
    'The Pay button in the checkout disappears in dark mode. Can you fix it?',
  );
  log.prompt(promptIdOf(4102), longPrompt);
  log.prompt(
    promptIdOf(4103),
    'Please check every component under src/components/checkout/payment-methods/saved-cards/ and replace the hard-coded hex colors with the tokens from the theme, keeping the focus rings visible in both light and dark mode.',
  );
  log.prompt(promptIdOf(4104), 'Tighten the checkout card using my notes.');
  flushedComment(log, promptIdOf(4104), {
    id: 'comment-users-1',
    line: 42,
    text: 'The primary button disappears in dark mode',
  });
  flushedComment(log, promptIdOf(4104), {
    id: 'comment-users-2',
    line: 18,
    label: 'h2',
    text: 'Title and list need 8px between them',
  });
});

/** The reader's turns: accepted, markdown, one long line, and with comments. */
export const UserTurns = {
  render: () => (
    <TurnsEditor
      threads={userTurns.threads}
      turns={userTurns.turns.filter((turn) => turn.type === 'user')}
    />
  ),
};

const pendingTurn: UserTurn = {
  type: 'user',
  promptId: '',
  events: [],
  text: 'Also run the e2e tests before you finish.',
  accepted: false,
  comments: [],
  awaiting: false,
};

/** The words the reader just sent, dimmed and nameless before the host accepts. */
export const UserTurnPending = {
  render: () => <TurnsEditor turns={[pendingTurn]} />,
};

// Agent turns ---------------------------------------------------------------

const agentTurns = projectLog((log) => {
  const answered = promptIdOf(4201);
  log.prompt(answered, 'Why does the Pay button vanish in dark mode?');
  answer(
    log,
    answered,
    'The button used a hard-coded `bg-white`, so in dark mode it blended into the card. It now uses the `primary` token.',
  );

  const markdown = promptIdOf(4202);
  log.prompt(markdown, 'What did the redesign change?');
  answer(log, markdown, redesignAnswer);

  const long = promptIdOf(4203);
  log.prompt(long, 'Explain the price helpers.');
  answer(log, long, longAnswer);

  const cancelled = promptIdOf(4204);
  log.prompt(cancelled, 'Rewrite every test in the checkout package.');
  log.push(cancelled, { type: 'agent.started' });
  log.text(cancelled, 'I started with `checkout.test.tsx` and');
  log.push(cancelled, {
    type: 'prompt.finished',
    status: 'cancelled',
    text: '',
    source: { kind: 'user' },
  });

  const streaming = promptIdOf(4205);
  log.prompt(streaming, 'Summarize what changed in the checkout.');
  log.push(streaming, { type: 'agent.started' });
  log.text(streaming, 'So far the checkout card has a new grid: the summary');
  log.text(streaming, ' sits above the payment form, and the');
});

/** Settled answers, a cancelled run, and the answer still being written. */
export const AgentTurns = {
  render: () => (
    <TurnsEditor
      turns={agentTurns.turns.filter((turn) => turn.type === 'agent')}
    />
  ),
};

// Thinking and activity -----------------------------------------------------

const thinkingTurns = projectLog((log) => {
  const settled = promptIdOf(4301);
  log.prompt(settled, 'Fix the Pay button in dark mode.');
  log.thinking(settled, reasoning);
  answer(log, settled, 'The button now uses the `primary` token.');

  const live = promptIdOf(4302);
  log.prompt(live, 'Plan the checkout migration.');
  log.push(live, { type: 'agent.started' });
  log.thinking(live, 'The reader says the Pay button disappears in ');
  log.thinking(live, 'dark mode. The button likely uses a hard-coded');
});

/** Reasoning the run settled, and reasoning still arriving. */
export const ThinkingSteps = {
  render: () => (
    <TurnsEditor
      turns={thinkingTurns.turns.filter((turn) => turn.type === 'thinking')}
    />
  ),
};

const activityTurns = projectLog((log) => {
  const prompt = promptIdOf(4401);
  log.prompt(prompt, 'Find every hard-coded background in the checkout.');
  log.thinking(
    prompt,
    'I should read the checkout component, then grep for `bg-white`.',
  );
  log.tool(
    prompt,
    'call-1',
    'read',
    { path: 'src/components/Checkout.tsx' },
    { output: 'export function Checkout({ total }: CheckoutProps) { … }' },
  );
  log.tool(
    prompt,
    'call-2',
    'grep',
    { pattern: 'bg-white', path: 'src' },
    {
      output:
        'src/components/Checkout.tsx:41\nsrc/components/CartSummary.tsx:18',
    },
  );
  log.thinking(prompt, 'Two matches. Both are backgrounds of cards.');
  answer(log, prompt, 'Two hard-coded backgrounds remain; both are listed.');
});

/** One folded burst of reasoning and calls, and the answer it produced. */
export const ActivityBurst = {
  render: () => (
    <TurnsEditor
      turns={activityTurns.turns.filter(
        (turn) => turn.type === 'activity' || turn.type === 'agent',
      )}
    />
  ),
};

// Tool calls ----------------------------------------------------------------

const toolTurns = projectLog((log) => {
  const prompt = promptIdOf(4501);
  log.prompt(prompt, 'Fix the Pay button in dark mode.');
  log.push(prompt, { type: 'agent.started' });
  log.tool(
    prompt,
    'call-1',
    'read',
    { path: 'src/components/Checkout.tsx' },
    { output: 'export function Checkout({ total }: CheckoutProps) { … }' },
  );
  log.tool(prompt, 'call-2', 'edit', JSON.parse(editArgs), {
    output: editResult,
  });
  log.tool(
    prompt,
    'call-3',
    'terminal',
    JSON.parse(terminalArgs(testCommand)),
    {
      output: terminalResult({ command: testCommand, stdout: passingTests }),
    },
  );
  log.tool(prompt, 'call-4', 'terminal', JSON.parse(terminalArgs('npm test')), {
    output: terminalResult({
      command: 'npm test',
      stdout: passingTests.slice(0, 3),
      stderr: failingTests,
      exitCode: 1,
      durationMs: 8_420,
    }),
  });

  const running = promptIdOf(4502);
  log.prompt(running, 'Add an order history page under /orders.');
  log.push(running, { type: 'agent.started' });
  log.tool(running, 'call-5', 'write', JSON.parse(writeArgs));
});

/** Each tool call row: read, edit, a passing and a failing terminal, a write. */
export const ToolCalls = {
  render: () => (
    <TurnsEditor
      turns={toolTurns.turns.filter((turn) => turn.type === 'tool_call')}
    />
  ),
};

// Turn footers ---------------------------------------------------------------

const authoredTurns = turnsOfLog((log) => {
  const prompt = promptIdOf(4601);
  log.prompt(prompt, 'Fix the Pay button in dark mode.');
  answer(log, prompt, 'The button now uses the `primary` token.');
});

/** The reader's and the agent's footers, and the one with no time yet. */
export const TurnAuthorLines = {
  render: () => (
    <ConversationEditor
      seed={() => {
        $appendTurns(authoredTurns);
        $appendPromptTail(nodesThread);
      }}
    />
  ),
};

// Delegated and terminal turns ----------------------------------------------

const delegatedTurns = turnsOfLog((log) => {
  log.push(promptIdOf(4701), {
    type: 'prompt.accepted',
    text: 'Check the color contrast of every checkout component against WCAG AA and report the failing pairs.',
    source: { kind: 'parent', threadId: parentThread.id },
  });
  log.push(promptIdOf(4702), {
    type: 'prompt.accepted',
    text: [
      '# Delegated task result',
      `Thread: ${childThread.id}`,
      `Parent: ${nodesThread.id}`,
      `Prompt: ${promptIdOf(4799)}`,
      'Status: completed',
      '## Result',
      'Two pairs fail WCAG AA:',
      '',
      '- muted text on the card (3.9:1)',
      '- the disabled button label (2.8:1)',
    ].join('\n'),
    source: { kind: 'result', threadId: childThread.id },
  });
});

/** A parent Thread's instruction, and the result a subthread handed back. */
export const DelegatedTurns = {
  render: () => <TurnsEditor turns={delegatedTurns} />,
};

const terminalId = 'terminal-3f8a';
const terminalOrigin = promptIdOf(4800);

const terminalTurns = turnsOfLog((log) => {
  log.push(promptIdOf(4801), {
    type: 'prompt.accepted',
    text: backgroundResult({
      terminalId,
      promptId: terminalOrigin,
      command: testCommand,
      stdout: passingTests.join('\n'),
      durationMs: 1_940,
    }),
    source: { kind: 'terminal', terminalId },
  });
  log.push(promptIdOf(4802), {
    type: 'prompt.accepted',
    text: backgroundResult({
      terminalId,
      promptId: terminalOrigin,
      command: 'npm test',
      stdout: passingTests.slice(0, 5).join('\n'),
      stderr: failingTests.join('\n'),
      exitCode: 1,
      durationMs: 2_340,
    }),
    source: { kind: 'terminal', terminalId },
  });
});

/** A background command that passed, and a failing test run. */
export const TerminalResults = {
  render: () => <TurnsEditor turns={terminalTurns} />,
};

// Lifecycle, compaction and failure turns -----------------------------------

const lifecycleTurns = turnsOfType('lifecycle', (log) => {
  const paused = promptIdOf(4901);
  log.prompt(paused, 'Upgrade the app to React 19 and fix the type errors.');
  log.push(paused, { type: 'agent.started' });
  log.push(paused, { type: 'prompt.paused', reason: 'host_stopped' });

  const stopped = promptIdOf(4902);
  log.prompt(stopped, 'Rewrite every test in the checkout package.');
  log.push(stopped, { type: 'agent.started' });
  log.push(stopped, { type: 'prompt.paused', reason: 'reader_stopped' });

  const restarted = promptIdOf(4903);
  log.prompt(restarted, 'Run the whole test suite and fix what fails.');
  log.push(restarted, { type: 'agent.started' });
  log.push(restarted, { type: 'prompt.paused', reason: 'host_restarted' });
  log.push(restarted, { type: 'prompt.resumed', attempt: 1 });
  log.push(restarted, { type: 'agent.started' });
});

/** A run paused by the host, one stopped by the reader, and one resumed. */
export const LifecycleTurns = {
  render: () => <TurnsEditor turns={lifecycleTurns} />,
};

const compactionTurns = turnsOfType('compaction', (log) => {
  const closed = promptIdOf(5001);
  log.prompt(closed, 'Run the whole test suite and fix what fails.');
  log.push(closed, { type: 'agent.started' });
  // The row sits inside a run: an agent turn before it, and the run's next
  // answer after it.
  log.text(
    closed,
    'The suite has two failing files; I will fix them one at a time.',
  );
  log.push(closed, { type: 'compaction.started', trigger: 'automatic' });
  log.push(closed, {
    type: 'compaction.finished',
    summaryId: 'summary-transcript-1',
    summary,
    condensedMessages: 18,
    tokensFreed: 42_150,
  });
  answer(log, closed, 'The suite passes again with the new tokens.');

  const compacting = promptIdOf(5002);
  log.prompt(compacting, 'Continue with the order history page.');
  log.push(compacting, { type: 'agent.started' });
  log.text(
    compacting,
    'The list renders; the page still needs its empty state.',
  );
  log.push(compacting, { type: 'compaction.started', trigger: 'manual' });
});

/** A compaction that closed with its summary, and one still running. */
export const CompactionTurns = {
  render: () => <TurnsEditor turns={compactionTurns} />,
};

const failureTurns = turnsOfType('failure', (log) => {
  const provider = promptIdOf(5101);
  log.prompt(provider, 'Deploy the preview to staging.');
  log.push(provider, { type: 'agent.started' });
  log.push(provider, { type: 'agent.failed', error: failingError });
  log.push(provider, {
    type: 'prompt.finished',
    status: 'failed',
    text: '',
    source: { kind: 'user' },
  });

  const exhausted = promptIdOf(5102);
  log.prompt(exhausted, 'Upgrade the app to React 19 and fix the type errors.');
  log.push(exhausted, { type: 'agent.started' });
  log.push(exhausted, { type: 'agent.failed', error: resumeError });
  log.push(exhausted, {
    type: 'prompt.finished',
    status: 'failed',
    text: '',
    source: { kind: 'user' },
  });
});

/** A provider error, and a resume the host gave up on. */
export const FailureTurns = {
  render: () => <TurnsEditor turns={failureTurns} />,
};

// Queued receipts -----------------------------------------------------------

const queuedTurns = turnsOfType('queued', (log) => {
  for (const [n, text] of [
    [5201, 'Fix the two suites that still use jest.mock hoisting.'],
    [5202, 'Then remove @types/jest from the devDependencies.'],
  ] as const) {
    log.push(promptIdOf(n), {
      type: 'prompt.accepted',
      text,
      source: { kind: 'user' },
      queued: true,
    });
    log.push(promptIdOf(n), { type: 'prompt.queued' });
  }

  log.push(promptIdOf(5203), {
    type: 'prompt.accepted',
    text: 'The dev server exited with code 1: Cannot find module "vite-plugin-checker".',
    source: { kind: 'terminal', terminalId: 'terminal-dev' },
    queued: true,
  });
  log.push(promptIdOf(5203), { type: 'prompt.queued' });
});

/** Two receipts folded into one row, and one a terminal queued. */
export const QueuedReceipts = {
  render: () => <TurnsEditor turns={queuedTurns} />,
};

// Replies -------------------------------------------------------------------

const repliesProjection = projectLog((log) => {
  const prompt = promptIdOf(5301);
  log.prompt(prompt, 'Tighten the checkout card using my notes.');
  flushedComment(log, prompt, {
    id: 'comment-transcript-1',
    line: 42,
    text: 'The primary button disappears in dark mode',
  });
  flushedComment(log, prompt, {
    id: 'comment-transcript-2',
    line: 18,
    label: 'h2',
    text: 'Title and list need 8px between them',
  });
  commentReply(log, prompt, {
    id: 'comment-transcript-3',
    callId: 'call-1',
    inReplyTo: 'comment-transcript-1',
    line: 42,
    text: 'Fixed: the button now uses the `primary` token in both themes.',
  });
  log.push(prompt, {
    type: 'comments.resolved/v1',
    commentId: 'comment-transcript-1',
    resolved: true,
  });
  commentReply(log, prompt, {
    id: 'comment-transcript-4',
    callId: 'call-2',
    inReplyTo: 'comment-transcript-2',
    line: 18,
    label: 'h2',
    text: 'Should the gap be 8px on mobile too, or only from `md` up?',
  });
  answer(log, prompt, 'One note is fixed; one question is still open.');
});

/** A resolved reply, and one still waiting for the reader's answer. */
export const RepliesTurn = {
  render: () => (
    <TurnsEditor
      threads={repliesProjection.threads}
      turns={repliesProjection.turns.filter(
        (turn) => turn.type === 'replies' || turn.type === 'agent',
      )}
    />
  ),
};

// The composer --------------------------------------------------------------

const aboveQueue: ThreadQueue = {
  revision: 3,
  paused: false,
  stopping: false,
  current: queueItem(5401, 'Profile the production build.'),
  items: [
    queueItem(5402, 'Cache the TypeScript build info in CI.'),
    queueItem(5403, 'Then open a pull request with the numbers.'),
  ],
};

/** The queue node standing above the composer prompt. */
export const QueueAbovePrompt = {
  render: () => (
    <ConversationEditor
      host={{ queues: { [nodesThread.id]: aboveQueue } }}
      seed={() => {
        $appendPromptTail(nodesThread);
      }}
    />
  ),
};

const stackWords = 'Fix these before the release.';

/** The drafted comments above the words they will be sent with. */
export const ComposerStack = {
  render: () => (
    <ConversationEditor
      host={{
        drafts: {
          [nodesThread.id]: {
            text: stackWords,
            items: [
              stackItem(1, 'The primary button disappears in dark mode', 42),
              stackItem(2, 'Title and list need 8px between them', 18, 'h2'),
            ],
          },
        },
      }}
      seed={() => {
        $appendPromptTail(nodesThread, stackWords);
      }}
    />
  ),
};

const editable = queueItem(
  5501,
  'Document the retry options of the API client.',
);
const editWords =
  'Document the retry options of the API client, with one example each.';

/** The prompt-edit heading above the prompt holding the edited words. */
export const PromptEditing = {
  render: () => (
    <ConversationEditor
      host={{
        queues: {
          [nodesThread.id]: {
            revision: 2,
            paused: false,
            stopping: false,
            items: [editable],
          },
        },
      }}
      edits={{ [nodesThread.id]: queueEditOf(editable, editWords) }}
      seed={() => $appendPromptTail(nodesThread, editWords).prompt.selectEnd()}
    >
      <EditQueuePrompt threadId={nodesThread.id} />
    </ConversationEditor>
  ),
};

/** The composer prompt being written, several lines of markdown. */
export const ComposerPrompt = {
  render: () => (
    <ConversationEditor
      seed={() => {
        const { prompt } = $appendPromptTail(
          nodesThread,
          'Consolidate the price helpers:',
        );
        prompt.append($createLineBreakNode());
        prompt.append($createLineBreakNode());
        prompt.append($createTextNode('- keep `formatTotal`'));
      }}
    />
  ),
};

// Blocks and attachments ----------------------------------------------------

const chatBlockTurns = turnsOfLog((log) => {
  const prompt = promptIdOf(5601);
  log.prompt(prompt, 'Deploy the preview to staging.');
  answer(log, prompt, 'The preview is live on staging.');
});

const chatBlocks = blocksOf(
  previewBlock(promptIdOf(5601)),
  unknownBlock(promptIdOf(5601)),
);

/** A generic block and an unknown block type, seated among the turns. */
export const ChatBlocks = {
  render: () => (
    <ConversationEditor
      blocks={chatBlocks}
      seed={() => {
        const [user, agent] = $appendTurns(chatBlockTurns);
        user
          ?.getNextSibling()
          ?.insertAfter(
            $createChatBlockNode(previewBlock(promptIdOf(5601)).block.id),
          );
        agent?.insertBefore(
          $createChatBlockNode(unknownBlock(promptIdOf(5601)).block.id),
        );
        $appendPromptTail(nodesThread);
      }}
    />
  ),
};

/** An attachment reference standing in the composer prompt. */
export const AttachmentImage = {
  render: () => (
    <ConversationEditor
      seed={() => {
        const { prompt } = $appendPromptTail(
          nodesThread,
          'Paste the screenshot of the broken card:',
        );
        prompt.append(
          $createAttachmentImageNode(
            'checkout-dark.png',
            '<sha256-8f2c4a1e9b7d5c30>',
          ),
        );
      }}
    />
  ),
};

// The grouped overview --------------------------------------------------------

// One transcript that shows every kind of turn in the order the conversation
// reads them, each under its own caption, so the kinds sit side by side instead
// of inside one long log (`FullConversation`) or in one story per kind (above).
// A transcript is a single unbroken conversation, so a caption is a story-only
// block (`$createSectionCaptionNode` in `stories/support/editor.tsx`) seated
// between the turns: one editor holds the whole page.

/** One section of the grouped overview: its caption, then the turns it shows. */
interface OverviewSection {
  readonly caption: string;
  readonly turns: readonly Turn[];
}

/** The reader's turn: the words, the comments they carried, the author line. */
const overviewReader = projectLog((log) => {
  const prompt = promptIdOf(6001);
  log.prompt(prompt, 'Tighten the checkout card using my notes.');
  flushedComment(log, prompt, {
    id: 'comment-overview-1',
    line: 42,
    text: 'The primary button disappears in dark mode',
  });
  flushedComment(log, prompt, {
    id: 'comment-overview-2',
    line: 18,
    label: 'h2',
    text: 'Title and list need 8px between them',
  });
});

/** The agent's answer: the markdown it wrote, under the line of its run. */
const overviewAnswer = turnsOfType('agent', (log) => {
  const prompt = promptIdOf(6002);
  log.prompt(prompt, 'Why does the Pay button vanish in dark mode?');
  answer(
    log,
    prompt,
    'The button used a hard-coded `bg-white`, so in dark mode it blended into the card. It now uses the `primary` token.',
  );
});

/** One tool call: an `edit`, drawn as the diff it made. */
const overviewTool = turnsOfType('tool_call', (log) => {
  const prompt = promptIdOf(6003);
  log.prompt(prompt, 'Fix the Pay button in dark mode.');
  log.tool(prompt, 'call-overview-1', 'edit', JSON.parse(editArgs), {
    output: editResult,
  });
});

/**
 * A `thread-spawn` a child answered as the review agent, on its own model and
 * effort, and one still spawning.
 */
const overviewSpawn = turnsOfType('tool_call', (log) => {
  const spawned = promptIdOf(6004);
  log.prompt(spawned, 'Audit the checkout card for accessibility issues.');
  log.tool(
    spawned,
    'call-spawn-overview-1',
    'thread-spawn',
    {
      prompt:
        'Audit the muted text and the disabled button label against WCAG AA on every card.',
      title: 'contrast audit',
      agent: 'review',
      model: 'gpt-5',
      effort: 'high',
    },
    {
      output: JSON.stringify({
        threadId: childThread.id,
        promptId: promptIdOf(6099),
      }),
    },
  );

  const spawning = promptIdOf(6005);
  log.prompt(spawning, 'Add an order history page under /orders.');
  log.tool(spawning, 'call-spawn-overview-2', 'thread-spawn', {
    prompt:
      'Sweep the order history page at 375px and report every row that overflows.',
    title: 'mobile sweep',
  });
});

/** The result a subthread handed back to the Thread that delegated the work. */
const overviewDelegated = turnsOfType('user', (log) => {
  log.push(promptIdOf(6006), {
    type: 'prompt.accepted',
    text: [
      '# Delegated task result',
      `Thread: ${childThread.id}`,
      `Parent: ${nodesThread.id}`,
      `Prompt: ${promptIdOf(6099)}`,
      'Status: completed',
      '## Result',
      'Two pairs fail WCAG AA:',
      '',
      '- muted text on the card (3.9:1)',
      '- the disabled button label (2.8:1)',
    ].join('\n'),
    source: { kind: 'result', threadId: childThread.id },
  });
});

/** A background command that settled into the Thread as an answer of its own. */
const overviewTerminal = turnsOfType('user', (log) => {
  const overviewTerminalId = 'terminal-overview';
  log.push(promptIdOf(6007), {
    type: 'prompt.accepted',
    text: backgroundResult({
      terminalId: overviewTerminalId,
      promptId: promptIdOf(6003),
      command: testCommand,
      stdout: passingTests.join('\n'),
      durationMs: 1_940,
    }),
    source: { kind: 'terminal', terminalId: overviewTerminalId },
  });
});

/** A run the host paused, drawn as the quiet lifecycle row. */
const overviewLifecycle = turnsOfType('lifecycle', (log) => {
  const paused = promptIdOf(6008);
  log.prompt(paused, 'Upgrade the app to React 19 and fix the type errors.');
  log.push(paused, { type: 'agent.started' });
  log.push(paused, { type: 'prompt.paused', reason: 'host_stopped' });
});

/**
 * A compaction inside a run: the agent answered, the history is condensed, and
 * the run goes on. The prompt that started the run is the section above; this
 * one shows what stands around the row.
 */
const overviewCompaction = turnsOfLog((log) => {
  const compacted = promptIdOf(6009);
  log.prompt(compacted, 'Run the whole test suite and fix what fails.');
  log.push(compacted, { type: 'agent.started' });
  log.text(
    compacted,
    'Two files fail. I will fix them one at a time, starting with the checkout test.',
  );
  log.push(compacted, { type: 'compaction.started', trigger: 'automatic' });
  log.push(compacted, {
    type: 'compaction.finished',
    summaryId: 'summary-overview-1',
    summary,
    condensedMessages: 18,
    tokensFreed: 42_150,
  });
  answer(
    log,
    compacted,
    'Both files pass now: the assertion expected the old `bg-white` class.',
  );
}).filter((turn) => turn.type !== 'user');

/** A prompt the host closed as a failure, drawn as the failure row. */
const overviewFailure = turnsOfType('failure', (log) => {
  const failed = promptIdOf(6010);
  log.prompt(failed, 'Deploy the preview to staging.');
  log.push(failed, { type: 'agent.started' });
  log.push(failed, { type: 'agent.failed', error: failingError });
  log.push(failed, {
    type: 'prompt.finished',
    status: 'failed',
    text: '',
    source: { kind: 'user' },
  });
});

/** Every kind of turn in reading order, each with one correct example. */
const overviewSections: readonly OverviewSection[] = [
  {
    caption:
      "The reader's turn: the words, the comments the send flushed with them, the author line",
    turns: overviewReader.turns,
  },
  { caption: "The agent's answer", turns: overviewAnswer },
  {
    caption: 'The tool call: an edit, drawn as the diff it made',
    turns: overviewTool,
  },
  {
    caption:
      'The thread spawn: one a child answered as the review agent, one still spawning',
    turns: overviewSpawn,
  },
  {
    caption: 'The delegated result: what the subthread handed back',
    turns: overviewDelegated,
  },
  { caption: 'The background terminal result', turns: overviewTerminal },
  {
    caption: 'The lifecycle row: a run the host paused',
    turns: overviewLifecycle,
  },
  {
    caption:
      'The compaction row: the run has answered, the history is condensed, the run goes on',
    turns: overviewCompaction,
  },
  { caption: 'The failure row: a provider error', turns: overviewFailure },
];

/** The words the composer holds while its drafted comments wait above it. */
const overviewWords = 'Fix these before the release.';

const overviewHost = {
  queues: {
    [nodesThread.id]: {
      revision: 2,
      paused: false,
      stopping: false,
      current: queueItem(6011, 'Profile the production build.'),
      items: [queueItem(6012, 'Cache the TypeScript build info in CI.')],
    },
  },
  drafts: {
    [nodesThread.id]: {
      text: overviewWords,
      items: [
        stackItem(1, 'The total should align with the button baseline', 44),
      ],
    },
  },
} satisfies Parameters<typeof ConversationEditor>[0]['host'];

/** One section in the editor: its caption row, then the turns it shows. */
const $appendSection = (caption: string, turns: readonly Turn[] = []): void => {
  $getRoot().append($createSectionCaptionNode(caption));
  $appendTurns(turns);
};

/**
 * Every kind of turn, grouped: one captioned section per kind, in the order the
 * transcript reads them, each showing one correct example. The reader's turn
 * carries only the words it sent, the comments the send flushed with them and
 * its author line; every other kind carries only what its own block draws.
 * `FullConversation` stays the whole-Thread view, and the stories above stay the
 * reference for one kind.
 */
export const TurnsOverview = {
  render: () => (
    <ConversationEditor
      host={overviewHost}
      threads={overviewReader.threads}
      seed={() => {
        for (const { caption, turns } of overviewSections) {
          $appendSection(caption, turns);
        }
        $appendSection('The queue above the prompt, and the prompt below it');
        const { queue } = $appendPromptTail(nodesThread, overviewWords);
        queue.insertAfter(
          $createSectionCaptionNode(
            'The composer stack: the comments drafted above the words they go out with',
          ),
        );
      }}
    />
  ),
};
