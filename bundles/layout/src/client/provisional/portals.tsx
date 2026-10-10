// The layout's own region items (stage 9 §5.3–§5.4, D9-12): the footer's
// working directory (`layout-cwd`, order 10) and usage (`layout-thread-usage`,
// order 30), and the header's new-terminal button (`layout-new-terminal`,
// order 10). Each is a `display: contents` host element with no React root of
// its own; the workspace view renders `ProvisionalPortals`, which portals the
// content into every connected host, so the items share the view's state and
// query client the way they did as children of the old footer and header.

import { Button } from 'desktop-ui/button';
import { portalHosts } from 'desktop-ui/react-element';
import { TerminalIcon } from 'lucide-react';
import { createPortal } from 'react-dom';

import type { Thread } from '../domain/workspace.js';
import type { ProjectFiles } from './files/hooks/use-project-files.js';
import { WorkspaceCwd } from './git/components/workspace-cwd.js';
import { ThreadUsage } from './usage/components/thread-usage.js';

/** `layout-cwd`: the footer's working directory, branch and changes. */
export const cwdHosts = portalHosts<Record<string, never>>([]);

/** `layout-thread-usage`: the footer's context and cost. */
export const usageHosts = portalHosts<Record<string, never>>([]);

/** `layout-new-terminal`: the header's "New terminal" button. */
export const newTerminalHosts = portalHosts<Record<string, never>>([]);

export type ProvisionalPortalsProps = {
  /** The selected Thread, when the tree describes it. */
  readonly thread?: Thread;
  /** The selected Project's changes, read by the files panel's hook. */
  readonly changes: ProjectFiles['changes'];
  /** Shows the changes view of the files panel. */
  readonly onShowChanges: () => void;
  /** Opens a manual terminal on the selected Thread; absent without one. */
  readonly onNewTerminal?: () => void;
};

export function ProvisionalPortals({
  thread,
  changes,
  onShowChanges,
  onNewTerminal,
}: ProvisionalPortalsProps) {
  const cwd = cwdHosts.useHosts();
  const usage = usageHosts.useHosts();
  const newTerminal = newTerminalHosts.useHosts();
  return (
    <>
      {cwd.map((host, index) =>
        createPortal(
          <div className="mr-auto flex min-w-0 flex-1 items-center gap-1">
            <WorkspaceCwd
              key={thread?.id}
              thread={thread}
              changes={changes}
              onShowChanges={onShowChanges}
            />
          </div>,
          host.element,
          `cwd-${index}`,
        ),
      )}
      {usage.map((host, index) =>
        createPortal(
          <ThreadUsage thread={thread} />,
          host.element,
          `usage-${index}`,
        ),
      )}
      {newTerminal.map((host, index) =>
        createPortal(
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-2 shrink-0 [app-region:no-drag]"
            aria-label="New terminal"
            title="Open terminal"
            disabled={!onNewTerminal}
            onClick={onNewTerminal}
          >
            <TerminalIcon />
          </Button>,
          host.element,
          `new-terminal-${index}`,
        ),
      )}
    </>
  );
}
