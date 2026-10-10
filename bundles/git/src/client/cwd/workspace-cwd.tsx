import { changedLineTotals, messageFrom } from 'desktop-reads';
import { Button } from 'desktop-ui/button';
import { Popover, PopoverContent, PopoverTrigger } from 'desktop-ui/popover';
import { Separator } from 'desktop-ui/separator';
import { toast } from 'desktop-ui/sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop-ui/tooltip';
import { ChangeCounts, ReadFeedback } from 'desktop-ui/workspace';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  GitBranchIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { Thread } from 'runtime/contracts';

import type { ChangesObservation } from '../../contracts/index.js';
import { gitLine, gitStatusLine } from '../domain/thread-git.js';
import { useThreadGit } from '../hooks/use-thread-git.js';
import { BranchPicker } from './branch-picker.js';

/** The conversation's worktree context and directory-scoped changes shortcut. */
export function WorkspaceCwd({
  thread,
  changes,
  onShowChanges,
}: {
  readonly thread?: Thread;
  readonly changes: ChangesObservation['read'];
  readonly onShowChanges: () => void;
}) {
  const { error, git, refreshing, refresh } = useThreadGit(thread);
  const [branchesOpen, setBranchesOpen] = useState(false);
  if (!thread) return null;
  const totals =
    changes.status === 'ready'
      ? changedLineTotals(changes.value.repositories)
      : undefined;
  const root = git?.repo ? git.root : thread.cwd;
  const environment =
    git?.repo === false && git.status !== undefined
      ? git.status === 'pending'
        ? 'Preparing environment…'
        : 'Environment unavailable'
      : undefined;
  return (
    <>
      <ReadFeedback error={error} refreshing={refreshing} onRetry={refresh} />
      <Popover onOpenChange={() => setBranchesOpen(false)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="min-w-0 shrink gap-1.5"
                aria-label="Working directory and branch"
              >
                <span className="truncate" data-slot="workspace-cwd">
                  {thread.cwd}
                </span>
                {environment && (
                  <span
                    role="status"
                    className="truncate text-muted-foreground"
                  >
                    · {environment}
                  </span>
                )}
                {git?.repo && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="max-w-40 shrink-0 truncate">
                      {git.detached ? `@${git.head}` : git.head}
                    </span>
                  </>
                )}
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {thread.cwd}
            {git?.repo ? ` · ${gitLine(git)}` : ''}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 max-w-[calc(100vw-1rem)] gap-1 p-1"
        >
          <div className="flex flex-col gap-1 px-2 py-2">
            {environment && (
              <span className="text-xs text-muted-foreground">
                {environment}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {git?.repo ? 'Current worktree' : 'Working directory'}
            </span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {root.split('/').at(-1) || '/'}
              </span>
              <CopyButton value={root} label="Copy worktree path" />
            </div>
            <span
              className="truncate font-mono text-xs text-muted-foreground"
              title={root}
            >
              {root}
            </span>
            {git?.repo && (
              <span className="text-xs text-muted-foreground">
                {git.worktree ? 'Linked worktree' : 'Main worktree'}
              </span>
            )}
          </div>
          {git?.repo && (
            <>
              <Separator />
              <Popover open={branchesOpen} onOpenChange={setBranchesOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-start gap-2 px-2 py-2"
                    aria-label="Select branch"
                    disabled={thread.state === 'running'}
                  >
                    <GitBranchIcon data-icon="inline-start" />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="max-w-full truncate">
                        {git.detached ? `Detached · ${git.head}` : git.head}
                      </span>
                      <span className="max-w-full truncate text-xs font-normal text-muted-foreground">
                        {gitStatusLine(git)}
                      </span>
                    </span>
                    <ChevronRightIcon data-icon="inline-end" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="right"
                  align="end"
                  sideOffset={8}
                  className="w-80 max-w-[calc(100vw-1rem)] gap-0 p-0"
                  onEscapeKeyDown={(event) => event.stopPropagation()}
                >
                  <BranchPicker
                    key={thread.cwd}
                    thread={thread}
                    onSelect={() => setBranchesOpen(false)}
                  />
                </PopoverContent>
              </Popover>
            </>
          )}
        </PopoverContent>
      </Popover>
      {git?.repo && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0"
              aria-label="View changes in current directory"
              onClick={onShowChanges}
            >
              {totals ? (
                <ChangeCounts {...totals} />
              ) : (
                <span className="text-muted-foreground">…</span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>View changes in current directory</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function CopyButton({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="shrink-0"
      aria-label={label}
      title={label}
      onClick={() =>
        void navigator.clipboard
          .writeText(value)
          .catch((error) => toast.error(messageFrom(error)))
      }
    >
      <CopyIcon />
    </Button>
  );
}
