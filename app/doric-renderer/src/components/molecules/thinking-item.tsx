import { CollapsibleBlock } from '@/components/molecules/collapsible-block';
import { MarkdownText } from '@/components/molecules/markdown-text';
import { reasoningText } from '@/utility/reasoning-text';

type ThinkingItemProps = {
  readonly text: string;
  /** Whether the run is still being written: the block opens, and it shimmers. */
  readonly streaming: boolean;
};

/**
 * One run of the agent's reasoning as a block of the transcript. It is a widget
 * of its own because a completed burst of reasoning and tool calls renders the
 * same block inside its summary.
 *
 * The reasoning reads as one flow — its line breaks are the chunks it streamed
 * in — so it wears the emphasis of its marks in place, `**like this**` and
 * `` `this` ``, and never a block the source does not have.
 */
export function ThinkingItem({ streaming, text }: ThinkingItemProps) {
  const body = reasoningText(text);

  return (
    <CollapsibleBlock
      active={streaming}
      hasContent={body.length > 0}
      label={streaming ? 'Thinking' : 'Thought'}
    >
      <div className="break-words">
        <MarkdownText source={body} />
      </div>
    </CollapsibleBlock>
  );
}
