import { ComposerButton } from '@/components/molecules/composer-button';
import { ToolbarDivider } from '@/components/molecules/toolbar-divider';
import { ExecutionPicker } from '@/components/organisms/execution-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { connectionLabel } from '@/domain/connection';
import { compactPath } from '@/domain/cwd';
import type { ThreadIconKind } from '@/domain/sidebar';
import {
  gitBadgeKind,
  gitDetails,
  gitLine,
  type ThreadGit,
} from '@/domain/thread-git';
import type { Thread } from '@/domain/workspace';
import { useConnectionStatus } from '@/hooks/use-connection-status';
import { useThreadGit } from '@/hooks/use-thread-git';
import {
  GitBranchIcon,
  GithubIcon,
  MessageSquareIcon,
  SettingsIcon,
  TerminalIcon,
} from 'lucide-react';
import { type ComponentType, useEffect, useState } from 'react';

type WorkspaceFooterProps = {
  readonly onNewTerminal?: () => void;
  /** Whether a prompt is running on the selected Thread. */
  readonly running: boolean;
  /** Whether the prompt holds anything to send. */
  readonly canSend: boolean;
  /** Whether there is a selected Thread to run a prompt on at all. */
  readonly disabled?: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
  /** The selected Thread, whose working directory and git state the left shows. */
  readonly thread?: Thread;
};

/**
 * The application's status line, under the conversation. On the left it states
 * where the selected Thread works: the working directory, and — when that
 * directory is a repository — the git badge and its always-visible line. On the
 * right it carries the execution picker — the model, thinking and effort a
 * prompt runs with — and the composer's own control, which sends the reader's
 * prompt or stops the agent's run. Both belong here rather than beside the
 * prompt, because they describe what a prompt runs with rather than what it says.
 */
export function WorkspaceFooter({
  canSend,
  disabled,
  onNewTerminal,
  onSend,
  onStop,
  running,
  thread,
}: WorkspaceFooterProps) {
  return (
    <footer
      data-slot="workspace-footer"
      className="flex chrome-bar shrink-0 items-center justify-end gap-1 border-t bg-sidebar px-2 text-xs"
    >
      <div className="mr-auto flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New terminal"
          disabled={!onNewTerminal}
          onClick={onNewTerminal}
        >
          <TerminalIcon />
        </Button>
        {thread && <ToolbarDivider />}
        <WorkspaceCwd thread={thread} />
      </div>
      <ExecutionPicker />
      <ToolbarDivider />
      <ComposerButton
        canSend={canSend}
        disabled={disabled}
        onSend={onSend}
        onStop={onStop}
        running={running}
      />
    </footer>
  );
}

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
 * The left of the footer: the selected Thread's working directory as a button,
 * with the git badge and its line beside it when that directory is a repository.
 * The button opens the one popover that holds the repository's slower facts and
 * the field that moves the directory.
 */
function WorkspaceCwd({ thread }: { readonly thread?: Thread }) {
  const { cwdError, error, git, setCwd } = useThreadGit(thread);

  if (thread === undefined) return null;

  const kind = gitBadgeKind(git, thread.cwdRepo);
  const BadgeIcon = iconByKind[kind];
  const line = git !== undefined ? gitLine(git) : '';

  return (
    <div className="mr-auto flex min-w-0 items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="min-w-0 justify-start font-mono text-xs text-muted-foreground"
            title={error ?? thread.cwd}
          >
            <span className="truncate" data-slot="workspace-cwd">
              {compactPath(thread.cwd)}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80" side="top">
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

/** The main process's Socket.IO connection status, as the reader reads it. */
function ConnectionStatus() {
  const status = useConnectionStatus();

  return <span className="px-1">{connectionLabel(status)}</span>;
}

type WorkspaceSidebarFooterProps = {
  readonly onOpenSettings: () => void;
};

/**
 * The sidebar's own status line, sharing the footer's geometry on the menu side.
 * It states the connection to the host, so the content footer is free for what a
 * prompt runs with, and it carries the settings trigger at its far end, where a
 * menu's gear belongs — reachable while the sidebar is open and out of the way of
 * the composer.
 */
export function WorkspaceSidebarFooter({
  onOpenSettings,
}: WorkspaceSidebarFooterProps) {
  return (
    <div
      data-slot="workspace-sidebar-footer"
      className="flex chrome-bar shrink-0 items-center border-t bg-sidebar px-1 text-xs text-muted-foreground"
    >
      <ConnectionStatus />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Settings"
        className="ml-auto"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </Button>
    </div>
  );
}
