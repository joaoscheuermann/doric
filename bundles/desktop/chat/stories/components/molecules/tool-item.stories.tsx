import type { ComponentProps } from 'react';

import { ToolItem } from '../../../src/client/components/molecules/tool-item.js';
import { WithChosen } from '../../support/chosen.js';
import {
  editArgs,
  editResult,
  passingTests,
  terminalArgs,
  terminalResult,
  testCommand,
} from '../../support/fixtures.js';

type Props = Omit<ComponentProps<typeof ToolItem>, 'chosen' | 'onChosenChange'>;

function Tool({
  initial = null,
  ...props
}: Props & { readonly initial?: boolean | null }) {
  return (
    <WithChosen initial={initial}>
      {(chosen, onChosenChange) => (
        <ToolItem {...props} chosen={chosen} onChosenChange={onChosenChange} />
      )}
    </WithChosen>
  );
}

const grepArgs = JSON.stringify({ pattern: 'bg-white', path: 'src' });

export default {
  title: 'Chat/Molecules/Tool item',
  component: ToolItem,
};

export const Called = {
  render: () => (
    <Tool
      name="grep"
      args={grepArgs}
      result={
        'src/components/Checkout.tsx:41\nsrc/components/CartSummary.tsx:18'
      }
      status="finished"
    />
  ),
};

export const CalledOpened = {
  render: () => (
    <Tool
      name="grep"
      args={grepArgs}
      result={
        'src/components/Checkout.tsx:41\nsrc/components/CartSummary.tsx:18'
      }
      status="finished"
      initial
    />
  ),
};

export const Calling = {
  render: () => (
    <Tool
      name="web_fetch"
      args={JSON.stringify({ url: 'https://vitest.dev/guide/migration' })}
      status="running"
    />
  ),
};

export const Failed = {
  render: () => (
    <Tool
      name="read"
      args={JSON.stringify({ path: 'src/components/Payment.tsx' })}
      error="ENOENT: src/components/Payment.tsx does not exist"
      status="failed"
      initial
    />
  ),
};

export const NoArguments = {
  render: () => (
    <Tool name="list_threads" args="" result="3 Threads" status="finished" />
  ),
};

/** `terminal` calls are drawn by the terminal block. */
export const Terminal = {
  render: () => (
    <Tool
      name="terminal"
      args={terminalArgs(testCommand)}
      result={terminalResult({ command: testCommand, stdout: passingTests })}
      status="finished"
    />
  ),
};

/** `edit` and `write` calls are drawn by the file-diff block. */
export const Edit = {
  render: () => (
    <Tool name="edit" args={editArgs} result={editResult} status="finished" />
  ),
};
