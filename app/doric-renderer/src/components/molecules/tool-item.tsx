import { CollapsibleBlock } from '@/components/molecules/collapsible-block';
import type { ToolStatus } from '@/domain/projector';
import { humanize } from '@/utility/humanize';

type ToolItemProps = {
  readonly args: string;
  readonly error?: string;
  readonly name: string;
  readonly result?: string;
  readonly status: ToolStatus;
};

/**
 * One tool call as a block of the transcript, named by the tool it ran. It is a
 * widget of its own because a completed burst renders the same block inside its
 * summary.
 */
export function ToolItem({ args, error, name, result, status }: ToolItemProps) {
  const running = status === 'running';

  return (
    <CollapsibleBlock
      active={running}
      label={`${running ? 'Calling' : 'Called'} ${humanize(name)}`}
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
