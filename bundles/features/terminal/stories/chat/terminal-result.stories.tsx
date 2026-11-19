// A background terminal's answer in the chat's transcript (bundle isolation
// 5(b), change 4), moved from the chat's
// `components/organisms/conversation/nodes/terminal-result-node.stories.tsx`:
// the `terminal-result` element mounted alone, with the `view` the chat sets
// for the prompt the host writes when a background command settles.

import { useState } from 'react';

import { defineTerminalResultElement } from '../../src/client/chat/terminal-result.js';
import type { ChatInputView } from '../../src/client/peers.js';
import { ChatViewHost } from '../support/chat-view-host.js';
import {
  backgroundResult,
  failingTests,
  passingTests,
  threadId,
} from '../support/fixtures.js';
import { storyServices } from '../support/services.js';
import {
  storyTerminalApi,
  storyTerminalStore,
  storyWatches,
} from '../support/terminal-client.js';

/** The prompt that started the command, as the header names it. */
const origin = 'a0000000-0000-4000-8000-000000003099';

const terminalId = 'terminal-3f8a';

const devCommand = 'npm run dev -- --port 5173';

/**
 * The `view` of the answer a settled background command writes into its
 * Thread: a prompt of its own, sourced by the terminal that produced it.
 */
const answer = (input: {
  readonly command: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly reason?: 'exited' | 'timeout' | 'terminated' | 'failed';
  readonly durationMs?: number;
}): ChatInputView => ({
  projectId: 'prj_checkout',
  threadId,
  promptId: 'a0000000-0000-4000-8000-000000003101',
  source: { kind: 'terminal', terminalId },
  text: backgroundResult({ terminalId, promptId: origin, ...input }),
  chosen: null,
  focused: false,
});

/** A test run that passed, as the agent left it in the background. */
const passed = answer({
  command: 'npm test -- --run src/checkout',
  stdout: passingTests.join('\n'),
  durationMs: 1_940,
});

/** A test run that failed: folded, it still says so in its header. */
const failed = answer({
  command: 'npm test -- --run src/checkout',
  stdout: passingTests.slice(0, 5).join('\n'),
  stderr: failingTests.join('\n'),
  exitCode: 1,
  durationMs: 2_340,
});

/** A server the host stopped once its window ran out. */
const timedOut = answer({
  command: devCommand,
  stderr: 'Timed out after 30000 ms',
  exitCode: -1,
  reason: 'timeout',
  durationMs: 30_000,
});

/** A command that said nothing at all. */
const silent = answer({ command: 'git fetch origin', durationMs: 620 });

/** A long command, so the header's preview truncates and the card wraps. */
const longCommand = answer({
  command:
    'npx playwright test e2e/checkout.spec.ts --project=chromium --reporter=line --retries=2 --workers=4 --grep "@payments"',
  stdout: ['Running 6 tests using 4 workers', '  6 passed (14.2s)'].join('\n'),
  durationMs: 14_200,
});

/** One element class over a seeded terminal client, defined once per story. */
function Result({ view }: { readonly view: ChatInputView }) {
  const [element] = useState(() =>
    defineTerminalResultElement({
      api: storyTerminalApi(),
      watches: storyWatches(),
      store: storyTerminalStore(),
      open: () => undefined,
    }),
  );
  const [services] = useState(() => storyServices({}));
  return (
    <ChatViewHost
      tag="story-terminal-result"
      element={element}
      services={services}
      view={view}
    />
  );
}

export default {
  title: 'Terminal/Chat/Terminal result',
};

/** A command that finished cleanly: folded behind the command it answered. */
export const Folded = {
  render: () => <Result view={passed} />,
};

/** The same result opened: the command, how it exited and its output. */
export const Open = {
  render: () => <Result view={{ ...passed, chosen: true }} />,
};

/** A failure: open on its own, because a reader must not scroll past it. */
export const Failed = {
  render: () => <Result view={failed} />,
};

/** A command the host stopped at its window's end. */
export const TimedOut = {
  render: () => <Result view={timedOut} />,
};

/** A command that reported nothing in either stream. */
export const NoOutput = {
  render: () => <Result view={{ ...silent, chosen: true }} />,
};

/** A command longer than the header's preview holds. */
export const LongCommand = {
  render: () => <Result view={{ ...longCommand, chosen: true }} />,
};

/** The block holding the caret. */
export const Focused = {
  render: () => <Result view={{ ...passed, focused: true }} />,
};
