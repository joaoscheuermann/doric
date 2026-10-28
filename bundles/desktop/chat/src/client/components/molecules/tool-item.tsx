import { attachmentLine } from 'runtime/contracts';

import { type Chosen, toolOpenness } from '../../domain/collapsible.js';
import type { ToolStatus } from '../../domain/projector.js';
import { LOAD_SKILL_TOOL } from '../../domain/skill-load.js';
import { humanize } from '../../utility/humanize.js';
import { AttachmentImage } from './attachment-image.js';
import { CollapsibleBlock } from './collapsible-block.js';
import { EditToolItem } from './edit-tool-item.js';
import { SkillToolItem } from './skill-tool-item.js';
import { TerminalToolItem } from './terminal-tool-item.js';

type ToolItemProps = {
  readonly args: string;
  readonly error?: string;
  readonly name: string;
  readonly result?: string;
  readonly status: ToolStatus;
  /** The reader's choice of open/closed, held by the block's owner. */
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  /** Whether the block is the caret's stop; it then wears the hover style. */
  readonly focused?: boolean;
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
  result,
  status,
}: ToolItemProps) {
  if (name === 'terminal') {
    return (
      <TerminalToolItem
        args={args}
        chosen={chosen}
        error={error}
        focused={focused}
        onChosenChange={onChosenChange}
        result={result}
        status={status}
      />
    );
  }
  if (name === 'edit' || name === 'write') {
    return (
      <EditToolItem
        args={args}
        chosen={chosen}
        error={error}
        focused={focused}
        onChosenChange={onChosenChange}
        result={result}
        status={status}
      />
    );
  }
  if (name === LOAD_SKILL_TOOL) {
    return (
      <SkillToolItem
        args={args}
        chosen={chosen}
        error={error}
        focused={focused}
        onChosenChange={onChosenChange}
        result={result}
        status={status}
      />
    );
  }

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
      openness={toolOpenness(status, args, result, error, name)}
    >
      <div className="flex flex-col gap-1.5">
        {args.length > 0 ? (
          <div className="whitespace-pre-wrap break-words">{args}</div>
        ) : null}
        {result === undefined ? null : <ToolResult result={result} />}
        {error === undefined ? null : (
          <div className="text-destructive whitespace-pre-wrap break-words">
            {error}
          </div>
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
