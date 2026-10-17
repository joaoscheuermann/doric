import type { ComponentProps } from 'react';

import { TerminalToolItem } from '../../../src/client/components/molecules/terminal-tool-item.js';
import { WithChosen } from '../../support/chosen.js';
import {
  failingTests,
  passingTests,
  terminalArgs,
  terminalResult,
  testCommand,
} from '../../support/fixtures.js';
import { LiveTerminal } from '../../support/live-terminal.js';

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

export default {
  title: 'Chat/Molecules/Terminal tool item',
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

/** A session the terminal service streams while the call runs, with Stop. */
export const RunningLive = {
  render: () => (
    <LiveTerminal
      command={devCommand}
      output={[
        '> storefront@0.4.0 dev',
        '> vite --port 5173',
        '',
        '  VITE v6.0.3  ready in 412 ms',
        '',
        '  ➜  Local:   http://localhost:5173/',
      ].join('\n')}
    >
      <Terminal args={terminalArgs(devCommand)} status="running" />
    </LiveTerminal>
  ),
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
      error="The command was refused: it writes outside the sandbox."
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
