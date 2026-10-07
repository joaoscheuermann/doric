import { FileIcon, TriangleAlertIcon } from 'lucide-react';

import { ChangeCounts } from '@/components/molecules/change-counts';
import type { DiffControls } from '@/components/molecules/diff-editor';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { changeClassName, changeDescription } from '@/domain/change-tree';
import { baseName, changeLetter, parentPath } from '@/domain/files';
import type { ProjectChange } from '@/domain/workspace';
import { cn } from '@/utility/utils';

/** File identity and opening remain visible at every panel width. */
export function DiffToolbar({
  path,
  change,
  truncated,
  controls,
  canOpen,
  onOpen,
}: {
  readonly path: string;
  readonly change?: ProjectChange;
  readonly truncated?: boolean;
  readonly controls?: DiffControls;
  readonly canOpen: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <header className="shrink-0 border-b" data-slot="diff-toolbar">
      <div className="flex h-9 min-w-0 items-center gap-2 px-3">
        {change && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={changeDescription(change)}
                className={cn(
                  'shrink-0 text-xs font-normal',
                  changeClassName(change.status),
                )}
              >
                {changeLetter(change.status)}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              HEAD ↔ Working tree · {changeDescription(change)}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center font-mono text-xs font-normal"
              aria-label={path}
            >
              <span className="truncate text-muted-foreground">
                {parentPath(path) && `${parentPath(path)}/`}
              </span>
              <span
                className={cn(
                  'max-w-full shrink-0 truncate',
                  change?.status === 'deleted' && 'line-through',
                )}
              >
                {baseName(path)}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{path}</TooltipContent>
        </Tooltip>
        {controls && (
          <span className="shrink-0" aria-live="polite">
            {controls.counts ? (
              <ChangeCounts {...controls.counts} />
            ) : (
              <span className="text-xs text-muted-foreground">
                <span aria-hidden="true">…</span>
                <span className="sr-only">Comparing</span>
              </span>
            )}
          </span>
        )}
        {truncated && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Partial comparison"
              >
                <TriangleAlertIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Only the beginning of each file is shown; line counts are partial.
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label="Open file"
              disabled={!canOpen}
              onClick={onOpen}
            >
              <FileIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open file</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
