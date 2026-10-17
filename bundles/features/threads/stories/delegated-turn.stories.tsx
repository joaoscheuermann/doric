import { useState } from 'react';

import { DelegatedTurn } from '../src/client/delegated-turn.js';
import type { DelegatedInput } from '../src/client/domain/delegated.js';
import {
  childThread,
  failedResultText,
  instructionText,
  longNamedThread,
  parentThread,
  resultText,
  seedWorkspace,
  unknownThreadId,
} from './support/fixtures.js';
import { storyServices } from './support/services.js';

// The sender's label and link come from the layout's sidebar tree; every
// story reads the same tree, and the unknown-sender story names a Thread it
// does not hold.
seedWorkspace();

function Turn({
  input,
  initiallyOpen = input.kind === 'parent',
  focused = false,
}: {
  readonly input: DelegatedInput;
  readonly initiallyOpen?: boolean;
  readonly focused?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <DelegatedTurn
      input={input}
      open={open}
      focused={focused}
      onOpenChange={setOpen}
      services={storyServices}
    />
  );
}

export default {
  title: 'Threads/Molecules/Delegated turn',
  component: DelegatedTurn,
};

/** A parent's instruction: it starts open, and the sender is a link. */
export const Instruction = {
  render: () => (
    <Turn
      input={{
        kind: 'parent',
        threadId: parentThread.id,
        text: instructionText,
      }}
    />
  ),
};

/** A child's result: it starts closed, so the reader opens it. */
export const Result = {
  render: () => (
    <Turn
      input={{
        kind: 'result',
        threadId: childThread.id,
        status: 'completed',
        text: resultText,
      }}
    />
  ),
};

export const ResultOpen = {
  render: () => (
    <Turn
      initiallyOpen
      input={{
        kind: 'result',
        threadId: childThread.id,
        status: 'completed',
        text: resultText,
      }}
    />
  ),
};

export const FailedResult = {
  render: () => (
    <Turn
      initiallyOpen
      input={{
        kind: 'result',
        threadId: childThread.id,
        status: 'failed',
        text: failedResultText,
      }}
    />
  ),
};

/** A result without a recorded status draws no status line. */
export const ResultWithoutStatus = {
  render: () => (
    <Turn
      initiallyOpen
      input={{
        kind: 'result',
        threadId: childThread.id,
        text: 'Done: the CVC input now has a visible label.',
      }}
    />
  ),
};

/** The tree does not know the sender: its short id, in monospace, no link. */
export const UnknownSender = {
  render: () => (
    <Turn
      input={{
        kind: 'parent',
        threadId: unknownThreadId,
        text: 'Summarize the open review comments on the checkout PR.',
      }}
    />
  ),
};

export const Focused = {
  render: () => (
    <Turn
      focused
      initiallyOpen={false}
      input={{
        kind: 'parent',
        threadId: parentThread.id,
        text: instructionText,
      }}
    />
  ),
};

export const LongSenderName = {
  render: () => (
    <Turn
      input={{
        kind: 'parent',
        threadId: longNamedThread.id,
        text: 'Start with the Profile screen; it has the most custom validation.',
      }}
    />
  ),
};

/**
 * A Thread that was handed work and delegated part of it again: its
 * parent's instruction, then its own child's result.
 */
export const InstructionThenResult = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Turn
        input={{
          kind: 'parent',
          threadId: parentThread.id,
          text: instructionText,
        }}
      />
      <Turn
        input={{
          kind: 'result',
          threadId: childThread.id,
          status: 'completed',
          text: resultText,
        }}
      />
    </div>
  ),
};
