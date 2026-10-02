import { CollapsibleBlock } from '@/components/molecules/collapsible-block';
import { type Chosen, toolOpenness } from '@/domain/collapsible';
import type { ToolStatus } from '@/domain/projector';
import { humanize } from '@/utility/humanize';

type ToolItemProps = {
  readonly args: string;
  readonly error?: string;
  readonly name: string;
  readonly result?: string;
  readonly status: ToolStatus;
  /** The reader's choice of open/closed, when the block's owner holds it. */
  readonly chosen?: Chosen;
  readonly onChosenChange?: (chosen: boolean) => void;
};

/**
 * One tool call as a block of the transcript, named by the tool it ran. It is a
 * widget of its own because a completed burst renders the same block inside its
 * summary.
 */
export function ToolItem({
  args,
  chosen,
  error,
  name,
  onChosenChange,
  result,
  status,
}: ToolItemProps) {
  const running = status === 'running';

  return (
    <CollapsibleBlock
      chosen={chosen}
      label={`${running ? 'Calling' : 'Called'} ${humanize(name)}`}
      onChosenChange={onChosenChange}
      openness={toolOpenness(status, args, result, error)}
    >
      <div className="flex flex-col gap-1.5">
        {args.length > 0 ? (
          <div className="whitespace-pre-wrap break-words">{args}</div>
        ) : null}
        {result === undefined ? null : (
          <div className="whitespace-pre-wrap break-words">{result}</div>
        )}
        {error === undefined ? null : (
          <div className="text-destructive whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
      </div>
    </CollapsibleBlock>
  );
}
