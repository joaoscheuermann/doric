import { ThinkingItem } from '../../../src/client/components/molecules/thinking-item.js';
import type { Chosen } from '../../../src/client/domain/collapsible.js';
import { WithChosen } from '../../support/chosen.js';

const reasoning =
  'The reader says the Pay button disappears in dark mode. The button likely uses a hard-coded white background instead of the theme token.\n\nI should look at Checkout.tsx first, then search for other bg-white uses.';

function Thinking({
  text,
  streaming,
  initial = null,
  focused,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly initial?: Chosen;
  readonly focused?: boolean;
}) {
  return (
    <WithChosen initial={initial}>
      {(chosen, onChosenChange) => (
        <ThinkingItem
          text={text}
          streaming={streaming}
          chosen={chosen}
          onChosenChange={onChosenChange}
          focused={focused}
        />
      )}
    </WithChosen>
  );
}

export default {
  title: 'Chat/Molecules/Thinking item',
  component: ThinkingItem,
};

export const Thought = {
  render: () => <Thinking text={reasoning} streaming={false} />,
};

export const Streaming = {
  render: () => <Thinking text={reasoning} streaming />,
};

export const ThoughtOpened = {
  render: () => <Thinking text={reasoning} streaming={false} initial />,
};

/** A run that has not read back into words yet stays closed. */
export const StreamingEmpty = {
  render: () => <Thinking text="" streaming />,
};

export const Focused = {
  render: () => <Thinking text={reasoning} streaming={false} focused />,
};

export const Long = {
  render: () => (
    <Thinking
      text={Array.from({ length: 6 }, () => reasoning).join('\n\n')}
      streaming={false}
      initial
    />
  ),
};
