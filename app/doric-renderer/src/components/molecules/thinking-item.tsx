import { CollapsibleBlock } from '@/components/molecules/collapsible-block';
import { type Chosen, thinkingOpenness } from '@/domain/collapsible';
import { reasoningText } from '@/utility/reasoning-text';

type ThinkingItemProps = {
  readonly text: string;
  /** Whether the run is still being written: the block opens, and it shimmers. */
  readonly streaming: boolean;
  /** The reader's choice of open/closed, held by the block's owner. */
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  /** Whether the block is the caret's stop; it then wears the hover style. */
  readonly focused?: boolean;
};

/**
 * A run of the agent's reasoning as a block of the transcript. It is a widget
 * of its own because a completed burst of reasoning and tool calls renders the
 * same block inside its summary.
 *
 * The reasoning is read back into the prose the model wrote — the breaks the
 * stream left between words are closed, and the paragraphs it meant are kept —
 * and drawn as plain text, for no marks. The answer is the markdown the reader
 * sees; the reasoning is a throwaway they skim, so the two read differently on
 * purpose.
 */
export function ThinkingItem({
  chosen,
  focused,
  onChosenChange,
  streaming,
  text,
}: ThinkingItemProps) {
  const body = reasoningText(text);

  return (
    <CollapsibleBlock
      chosen={chosen}
      focused={focused}
      label={streaming ? 'Thinking' : 'Thought'}
      onChosenChange={onChosenChange}
      openness={thinkingOpenness(body, streaming)}
    >
      {/* The paragraph breaks are the model's own, so they are kept rather than
          collapsed away; the marks are its syntax, so they are not read. */}
      <div className="whitespace-pre-wrap break-words">{body}</div>
    </CollapsibleBlock>
  );
}
