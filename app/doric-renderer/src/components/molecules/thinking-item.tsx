import { CollapsibleBlock } from '@/components/molecules/collapsible-block';

type ThinkingItemProps = {
  readonly text: string;
  /** Whether the run is still being written: the block opens, and it shimmers. */
  readonly streaming: boolean;
};

/**
 * One run of the agent's reasoning as a block of the transcript. It is a widget
 * of its own because a completed burst of reasoning and tool calls renders the
 * same block inside its summary.
 */
export function ThinkingItem({ streaming, text }: ThinkingItemProps) {
  return (
    <CollapsibleBlock
      active={streaming}
      hasContent={text.length > 0}
      label={streaming ? 'Thinking' : 'Thought'}
    >
      <div className="whitespace-pre-wrap break-words">{text}</div>
    </CollapsibleBlock>
  );
}
