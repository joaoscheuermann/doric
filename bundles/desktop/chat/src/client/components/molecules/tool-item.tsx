import type { ErrorInfo } from 'desktop/reads';
import { type Chosen, CollapsibleBlock } from 'desktop/ui/collapsible-block';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { attachmentLine } from 'runtime/contracts';

import { toolOpenness } from '../../domain/collapsible.js';
import { chatErrorCatalog } from '../../domain/error-catalog.js';
import type { ToolStatus } from '../../domain/projector.js';
import { humanize } from '../../utility/humanize.js';
import { AttachmentImage } from './attachment-image.js';

type ToolItemProps = {
  readonly args: string;
  readonly error?: ErrorInfo;
  readonly name: string;
  readonly result?: string;
  readonly status: ToolStatus;
  /** The reader's choice of open/closed, held by the block's owner. */
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  /** Whether the block is the caret's stop; it then wears the hover style. */
  readonly focused?: boolean;
  /** Whether the settled block stays open until the reader closes it; `toolDrawing`'s answer. */
  readonly openByDefault?: boolean;
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
  focused,
  name,
  onChosenChange,
  openByDefault = false,
  result,
  status,
}: ToolItemProps) {
  const running = status === 'running';

  return (
    <CollapsibleBlock
      chosen={chosen}
      focused={focused}
      label={
        <>
          <span className="font-normal">{running ? 'Calling' : 'Called'}</span>{' '}
          <span className="font-light">{humanize(name)}</span>
        </>
      }
      onChosenChange={onChosenChange}
      openness={toolOpenness(status, args, result, error, openByDefault)}
    >
      <div className="flex flex-col gap-1.5">
        {args.length > 0 ? (
          <div className="whitespace-pre-wrap break-words">{args}</div>
        ) : null}
        {result === undefined ? null : <ToolResult result={result} />}
        {error === undefined ? null : (
          <ErrorNotice
            variant="compact"
            error={error}
            catalog={chatErrorCatalog}
            fallbackCode="tool_failed"
            context={{ Tool: name }}
          />
        )}
      </div>
    </CollapsibleBlock>
  );
}

/** A call's result: the image an attachment's line names, or its text. */
function ToolResult({ result }: { readonly result: string }) {
  const image = attachmentLine(result);
  return image === undefined ? (
    <div className="whitespace-pre-wrap break-words">{result}</div>
  ) : (
    <AttachmentImage id={image.id} name={image.name} />
  );
}
