// The row a `terminal` call draws in the chat's transcript (bundle isolation
// 5(b), change 4), moved from the chat's
// `components/molecules/terminal-tool-item.stories.tsx`. The settled rows draw
// `TerminalToolItem` alone; the live one mounts the `terminal-tool-call`
// element over a seeded terminal store and output watch, as the chat creates
// it for a running call.

import { errorFrom } from 'desktop/reads';
import { type ComponentProps, useState } from 'react';

import {
  defineTerminalCallElement,
  TerminalToolItem,
} from '../../src/client/chat/terminal-call.js';
import type { Terminal as TerminalRecord } from '../../src/client/domain/terminals.js';
import type { ChatToolView } from '../../src/client/peers.js';
import { ChatViewHost } from '../support/chat-view-host.js';
import { WithChosen } from '../support/chosen.js';
import {
  failingTests,
  passingTests,
  terminalArgs,
  terminalResult,
  testCommand,
  threadId,
} from '../support/fixtures.js';
import { storyServices } from '../support/services.js';
import {
  storyTerminalApi,
  storyTerminalStore,
  storyWatches,
} from '../support/terminal-client.js';

type Props = Omit<
  ComponentProps<typeof TerminalToolItem>,
  'chosen' | 'onChosenChange'
>;

function Terminal({
  initial = null,
  ...props
}: Props & { readonly initial?: boolean | null }) {
  return (
    <WithChosen initial={initial}>
      {(chosen, onChosenChange) => (
        <TerminalToolItem
          {...props}
          chosen={chosen}
          onChosenChange={onChosenChange}
        />
      )}
    </WithChosen>
  );
}

const devCommand = 'npm run dev -- --port 5173';

/** The agent's dev server the live call started, still running. */
const devServer: TerminalRecord = {
  id: 'term-story-1',
  projectId: 'prj_checkout',
  threadId,
  origin: 'agent',
  command: devCommand,
  cwd: '/workspace/storefront',
  startedAt: '2026-10-16T08:41:30.000Z',
  timeoutMs: null,
  state: 'running',
  pty: false,
};

/** A running call whose terminal streams into the row, with Stop. */
function LiveCall() {
  const [mounted] = useState(() => {
    const element = defineTerminalCallElement({
      api: storyTerminalApi([devServer]),
      watches: storyWatches({
        [devServer.id]: {
          snapshot: [
            '> storefront@0.4.0 dev',
            '> vite --port 5173',
            '',
            '  VITE v6.0.3  ready in 412 ms',
            '',
          ].join('\n'),
          chunks: ['  ➜  Local:   http://localhost:5173/\n'],
        },
      }),
      store: storyTerminalStore([devServer]),
      open: () => undefined,
    });
    const view: ChatToolView = {
      projectId: devServer.projectId,
      threadId,
      promptId: 'prompt-story-1',
      key: 'prompt-story-1/call-story-1',
      name: 'terminal',
      args: terminalArgs(devCommand),
      status: 'running',
      chosen: null,
      focused: false,
    };
    return { element, view, services: storyServices({}) };
  });
  return (
    <ChatViewHost
      tag="story-terminal-tool-call"
      element={mounted.element}
      services={mounted.services}
      view={mounted.view}
    />
  );
}

export default {
  title: 'Terminal/Chat/Terminal call',
  component: TerminalToolItem,
};

export const Ran = {
  render: () => (
    <Terminal
      args={terminalArgs(testCommand)}
      result={terminalResult({ command: testCommand, stdout: passingTests })}
      status="finished"
      initial
    />
  ),
};

export const RanFolded = {
  render: () => (
    <Terminal
      args={terminalArgs(testCommand)}
      result={terminalResult({ command: testCommand, stdout: passingTests })}
      status="finished"
    />
  ),
};

export const Running = {
  render: () => <Terminal args={terminalArgs(testCommand)} status="running" />,
};

/** A session the terminal's store and watch stream while the call runs, with Stop. */
export const RunningLive = {
  render: () => <LiveCall />,
};

export const FailedExitCode = {
  render: () => (
    <Terminal
      args={terminalArgs(testCommand)}
      result={terminalResult({
        command: testCommand,
        stdout: [' RUN  v2.1.4 /workspace/storefront', ''],
        stderr: failingTests,
        exitCode: 1,
      })}
      status="finished"
      initial
    />
  ),
};

export const FailedCall = {
  render: () => (
    <Terminal
      args={terminalArgs('rm -rf node_modules/.vite')}
      error={errorFrom(
        '',
        'The command was refused: it writes outside the sandbox.',
      )}
      status="failed"
      initial
    />
  ),
};

export const OmittedLines = {
  render: () => (
    <Terminal
      args={terminalArgs('npm run build')}
      result={terminalResult({
        command: 'npm run build',
        stdout: ['> storefront@0.4.0 build', '> vite build', 'transforming...'],
        tail: [
          '✓ 1284 modules transformed.',
          'dist/index.html                  0.46 kB',
          'dist/assets/index-4f2a.js      312.08 kB │ gzip: 98.41 kB',
          '✓ built in 6.12s',
        ],
        omitted: 214,
      })}
      status="finished"
      initial
    />
  ),
};

export const Background = {
  render: () => (
    <Terminal
      args={terminalArgs(devCommand, true)}
      result={JSON.stringify({ background: true, terminal_id: 'term-gone' })}
      status="finished"
      initial
    />
  ),
};

export const RawOutput = {
  render: () => (
    <Terminal
      args={terminalArgs('git status --short')}
      result=" M src/components/Checkout.tsx\n M src/components/CartSummary.tsx"
      status="finished"
      initial
    />
  ),
};

export const LongCommand = {
  render: () => (
    <Terminal
      args={terminalArgs(
        'npx playwright test e2e/checkout.spec.ts --project=chromium --reporter=line --retries=2 --workers=4 --grep "@payments"',
      )}
      result={terminalResult({
        command:
          'npx playwright test e2e/checkout.spec.ts --project=chromium --reporter=line --retries=2 --workers=4 --grep "@payments"',
        stdout: ['Running 6 tests using 4 workers', '  6 passed (14.2s)'],
      })}
      status="finished"
    />
  ),
};
