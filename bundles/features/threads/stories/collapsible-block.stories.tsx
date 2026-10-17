import { BotIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { CollapsibleBlock } from '../src/client/collapsible-block.js';

function Block({
  initiallyOpen,
  focused,
  sender = 'Ship the checkout redesign',
  children,
}: {
  readonly initiallyOpen: boolean;
  readonly focused?: boolean;
  readonly sender?: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <CollapsibleBlock
      label={
        <>
          <BotIcon className="size-4.5 shrink-0" aria-hidden="true" />
          <span>Instruction from:</span>
        </>
      }
      action={{
        toggleLabel: `Toggle instruction from ${sender}`,
        content: (
          <span className="inline-flex min-w-0 items-center">
            <span className="shrink-0">&quot;</span>
            <span className="truncate">{sender}</span>
            <span className="shrink-0">&quot;</span>
          </span>
        ),
      }}
      open={open}
      focused={focused}
      onOpenChange={setOpen}
    >
      {children}
    </CollapsibleBlock>
  );
}

export default {
  title: 'Threads/Molecules/Collapsible block',
  component: CollapsibleBlock,
};

export const Open = {
  render: () => (
    <Block initiallyOpen>
      Audit the payment form for accessibility and report what fails.
    </Block>
  ),
};

export const Closed = {
  render: () => (
    <Block initiallyOpen={false}>
      Audit the payment form for accessibility and report what fails.
    </Block>
  ),
};

export const Focused = {
  render: () => (
    <Block initiallyOpen={false} focused>
      Audit the payment form for accessibility and report what fails.
    </Block>
  ),
};

export const LongSender = {
  render: () => (
    <Block
      initiallyOpen
      sender="Migrate every settings screen from the legacy form library to the shared field components and remove the old validation helpers"
    >
      Start with the Profile screen; it has the most custom validation.
    </Block>
  ),
};
