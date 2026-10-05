import { ReadFeedback } from '@/components/molecules/read-feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { compactPath } from '@/domain/cwd';
import type { ThreadIconKind } from '@/domain/sidebar';
import {
  gitBadgeKind,
  gitDetails,
  gitLine,
  type ThreadGit,
} from '@/domain/thread-git';
import type { Thread } from '@/domain/workspace';
import { useThreadGit } from '@/hooks/use-thread-git';
import {
  AlertCircleIcon,
  GitBranchIcon,
  GithubIcon,
  MessageSquareIcon,
} from 'lucide-react';
import { type ComponentType, useEffect, useState } from 'react';

/** The glyph each semantic icon kind paints. */
const iconByKind: Record<
  ThreadIconKind,
  ComponentType<{ className?: string }>
> = {
  conversation: MessageSquareIcon,
  git: GitBranchIcon,
  github: GithubIcon,
};

/**
 * The sandbox footer: the selected Thread's working directory as a button,
 * with the git badge and its line beside it when that directory is a repository.
 * The button opens the one popover that holds the repository's slower facts and
 * the field that moves the directory.
 */
export function WorkspaceCwd({ thread }: { readonly thread?: Thread }) {
  const { cwdError, error, git, refreshing, refresh, setCwd } =
    useThreadGit(thread);

  if (thread === undefined) return null;

  const kind = gitBadgeKind(git, thread.cwdRepo);
  const BadgeIcon = iconByKind[kind];
  const line = git !== undefined ? gitLine(git) : '';

  return (
    <div className="mr-auto flex min-w-0 items-center gap-2 text-xs">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="min-w-0 justify-start font-mono text-xs text-muted-foreground"
            title={error ?? thread.cwd}
          >
            {error !== undefined && (
              <AlertCircleIcon
                data-icon="inline-start"
                aria-label="Git status could not be updated"
              />
            )}
            <span className="truncate" data-slot="workspace-cwd">
              {compactPath(thread.cwd)}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80" side="top">
          <ReadFeedback
            error={error}
            refreshing={refreshing}
            onRetry={refresh}
          />
          <span role="status" className="text-xs text-muted-foreground">
            {refreshing ? 'Updating Git status…' : ''}
          </span>
          <CwdPopover
            cwd={thread.cwd}
            cwdError={cwdError}
            git={git}
            onSetCwd={setCwd}
          />
        </PopoverContent>
      </Popover>
      {git?.repo === true && (
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <BadgeIcon className="size-3.5 shrink-0" />
          <span className="truncate">{line}</span>
        </span>
      )}
    </div>
  );
}

/**
 * What the cwd button opens: the repository's facts, then the field that moves
 * the working directory, whose refusal the host's own message states.
 */
function CwdPopover({
  cwd,
  cwdError,
  git,
  onSetCwd,
}: {
  readonly cwd: string;
  readonly cwdError?: string;
  readonly git?: ThreadGit;
  readonly onSetCwd: (cwd: string) => Promise<void>;
}) {
  const [value, setValue] = useState(cwd);

  // A directory the host accepted becomes the one the field now edits.
  useEffect(() => setValue(cwd), [cwd]);

  const details = git !== undefined ? gitDetails(git) : [];

  return (
    <>
      {details.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {details.map((detail) => (
            <div key={detail.label} className="contents">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="truncate font-mono" title={detail.value}>
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <form
        className="flex flex-col gap-2 border-t pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          void onSetCwd(value.trim());
        }}
      >
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor="workspace-cwd-field"
        >
          Working directory
        </label>
        <div className="flex gap-2">
          <Input
            id="workspace-cwd-field"
            className="font-mono text-xs"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" size="sm">
            Change
          </Button>
        </div>
        {cwdError !== undefined && (
          <p className="text-xs text-destructive">{cwdError}</p>
        )}
      </form>
    </>
  );
}
