import { cn } from 'desktop/ui/utils';
import { FileDiffIcon } from 'lucide-react';

import { type Chosen, toolOpenness } from '../../domain/collapsible.js';
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
 * An `edit` tool call rendered as a standalone file-diff block in the
 * transcript: its header shows the file path and `+added / −removed` counts,
 * and its body renders the unified diff lines with line numbers and colours.
 */
export function EditToolItem({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  status,
}: EditToolItemProps) {
  const running = status === 'running';
  const parsed = parseEditCall(args, result, error);
  const failed = status === 'failed' || parsed.success === false;
  const verb = running ? 'Editing' : failed ? 'Failed to edit' : 'Edited';
  const hasCounts = parsed.added > 0 || parsed.removed > 0;

  const label = (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <FileDiffIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0">{verb}</span>
      {parsed.fileName !== undefined ? (
        <span
          data-slot="edit-file-name"
          className="truncate font-mono text-xs text-foreground"
        >
          {parsed.fileName}
        </span>
      ) : (
        <span>file</span>
      )}
      {parsed.directory !== undefined ? (
        <span
          data-slot="edit-file-dir"
          className="truncate font-mono text-xs text-muted-foreground"
        >
          {parsed.directory}
        </span>
      ) : null}
      {hasCounts ? (
        <span
          data-slot="edit-counts"
          className="inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums"
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
        label={label}
        onChosenChange={onChosenChange}
        openness={toolOpenness(status, args, result, error, 'edit')}
      >
        <div className="flex flex-col gap-1.5">
          {parsed.error !== undefined && parsed.error.length > 0 ? (
            <div
              data-slot="edit-error"
              className="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
            >
              {parsed.error}
            </div>
          ) : null}
          {parsed.diffLines.length > 0 ? (
            <div
              data-slot="edit-diff"
              className="max-h-80 overflow-auto rounded-md border border-border bg-card/40 py-1 font-mono text-xs"
            >
              {parsed.diffLines.map((line, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static positional rows of one tool result
                  key={index}
                  data-slot="edit-diff-line"
                  data-kind={line.kind}
                  className={cn(
                    'flex min-w-full w-fit items-baseline leading-relaxed',
                    lineRowClass(line.kind),
                  )}
                >
                  <span className="w-9 shrink-0 select-none px-1.5 text-right text-[11px] tabular-nums text-muted-foreground/70">
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
                  <span className="flex-1 whitespace-pre pr-3">
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          ) : parsed.rawOutput !== undefined && parsed.rawOutput.length > 0 ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
              {parsed.rawOutput}
            </pre>
          ) : null}
        </div>
      </CollapsibleBlock>
    </div>
  );
}
