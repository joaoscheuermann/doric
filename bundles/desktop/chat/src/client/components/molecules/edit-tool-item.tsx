import { cn } from 'desktop/ui/utils';
import { memo, useMemo } from 'react';

import {
  blockOpen,
  type Chosen,
  toolOpenness,
} from '../../domain/collapsible.js';
import { type DiffLine, parseEditCall } from '../../domain/edit-tool.js';
import type { ToolStatus } from '../../domain/projector.js';
import { CollapsibleBlock } from './collapsible-block.js';

type EditToolItemProps = {
  readonly args: string;
  readonly error?: string;
  readonly result?: string;
  readonly status: ToolStatus;
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  readonly focused?: boolean;
};

const lineRowClass = (kind: DiffLine['kind']): string => {
  if (kind === 'add') {
    return 'bg-[color-mix(in_oklab,var(--paper-green)_12%,transparent)] text-foreground';
  }
  if (kind === 'remove') {
    return 'bg-[color-mix(in_oklab,var(--paper-red)_12%,transparent)] text-foreground';
  }
  return 'text-muted-foreground';
};

const lineMarker = (kind: DiffLine['kind']): string => {
  if (kind === 'add') return '+';
  if (kind === 'remove') return '-';
  return ' ';
};

const lineMarkerClass = (kind: DiffLine['kind']): string => {
  if (kind === 'add') return 'text-[var(--paper-green)]';
  if (kind === 'remove') return 'text-[var(--paper-red)]';
  return 'text-muted-foreground/60';
};

/**
 * An `edit` or `write` tool call rendered as a standalone file-diff block in the
 * transcript: its header shows the file name and `+added / −removed` counts,
 * and its body renders the unified diff lines directly below without a card or
 * vertical guide line.
 */
export const EditToolItem = memo(function EditToolItem({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  status,
}: EditToolItemProps) {
  const running = status === 'running';
  const parsed = useMemo(
    () => parseEditCall(args, result, error),
    [args, result, error],
  );
  const failed = status === 'failed' || parsed.success === false;
  const verb = running ? 'Editing' : failed ? 'Failed to edit' : 'Edited';
  const hasCounts = parsed.added > 0 || parsed.removed > 0;
  const openness = toolOpenness(status, args, result, error, 'edit');
  const open = blockOpen(chosen, openness);

  const label = (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <span className="shrink-0">{verb}</span>
      {parsed.fileName !== undefined ? (
        <span data-slot="edit-file-name" className="truncate font-mono">
          {parsed.fileName}
        </span>
      ) : (
        <span>file</span>
      )}
      {hasCounts ? (
        <span
          data-slot="edit-counts"
          className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums"
        >
          <span className="text-[var(--paper-green)]">+{parsed.added}</span>
          <span className="text-[var(--paper-red)]">−{parsed.removed}</span>
        </span>
      ) : null}
    </span>
  );

  return (
    <div data-slot="edit-tool">
      <CollapsibleBlock
        chosen={chosen}
        focused={focused}
        guide={false}
        label={label}
        onChosenChange={onChosenChange}
        openness={openness}
      >
        {open ? (
          <div className="flex flex-col gap-1.5">
            {parsed.error !== undefined && parsed.error.length > 0 ? (
              <div
                data-slot="edit-error"
                className="whitespace-pre-wrap break-words font-mono text-sm text-destructive"
              >
                {parsed.error}
              </div>
            ) : null}
            {parsed.diffLines.length > 0 ? (
              <div
                data-slot="edit-diff"
                className="font-mono text-sm [content-visibility:auto] [contain-intrinsic-size:auto_120px]"
              >
                {parsed.diffLines.map((line, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static positional rows of one tool result
                    key={index}
                    data-slot="edit-diff-line"
                    data-kind={line.kind}
                    className={cn(
                      'flex w-full items-baseline leading-relaxed',
                      lineRowClass(line.kind),
                    )}
                  >
                    <span className="w-8 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/70">
                      {line.lineNumber ?? ''}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        'w-4 shrink-0 select-none text-center',
                        lineMarkerClass(line.kind),
                      )}
                    >
                      {lineMarker(line.kind)}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">
                      {line.text}
                    </span>
                  </div>
                ))}
              </div>
            ) : parsed.rawOutput !== undefined &&
              parsed.rawOutput.length > 0 ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-sm text-muted-foreground">
                {parsed.rawOutput}
              </pre>
            ) : null}
          </div>
        ) : null}
      </CollapsibleBlock>
    </div>
  );
});
