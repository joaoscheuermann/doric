import { memo, useMemo } from 'react';

import { type Chosen, skillOpenness } from '../../domain/collapsible.js';
import type { ToolStatus } from '../../domain/projector.js';
import { parseSkillLoad, skillSourceLabel } from '../../domain/skill-load.js';
import { CollapsibleBlock } from './collapsible-block.js';

type SkillToolItemProps = {
  readonly args: string;
  readonly error?: string;
  readonly result?: string;
  readonly status: ToolStatus;
  /** The reader's choice of open/closed, held by the block's owner. */
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  /** Whether the block is the caret's stop. */
  readonly focused?: boolean;
};

const VERBS: Readonly<Record<ToolStatus, string>> = {
  running: 'Loading skill',
  finished: 'Loaded skill',
  failed: 'Failed to load skill',
};

/**
 * A `load_skill` call as its own block. Header: verb by status ("Loading
 * skill" / "Loaded skill" / "Failed to load skill"), the name (font-mono), the
 * muted `skillSourceLabel`. Body: the result as plain pre-wrap text, or the
 * error in text-destructive. Openness `skillOpenness(status)` via
 * CollapsibleBlock.
 */
export const SkillToolItem = memo(function SkillToolItem({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  status,
}: SkillToolItemProps) {
  const { name, source } = useMemo(() => parseSkillLoad(args), [args]);

  return (
    <CollapsibleBlock
      chosen={chosen}
      focused={focused}
      label={
        <>
          <span className="font-normal">{VERBS[status]}</span>{' '}
          <span data-slot="skill-name" className="font-mono font-light">
            {name}
          </span>{' '}
          <span
            data-slot="skill-source"
            className="font-light text-muted-foreground/70"
          >
            · {skillSourceLabel(source)}
          </span>
        </>
      }
      onChosenChange={onChosenChange}
      openness={skillOpenness(status)}
    >
      {error !== undefined ? (
        <div className="whitespace-pre-wrap break-words text-destructive">
          {error}
        </div>
      ) : result !== undefined ? (
        <div className="whitespace-pre-wrap break-words">{result}</div>
      ) : null}
    </CollapsibleBlock>
  );
});
