// <git-workspace-cwd> (stage 10, §3.8): the footer's working directory,
// branch and changes shortcut for the selected Thread, moved from the
// layout's provisional `layout-cwd` portal. It renders nothing without a
// Thread; the changes button shows the panel's Changes view.

import type { Services } from 'bundle/contracts';
import { LayoutPanelV1 } from 'layout/contracts';

import { useChanges } from '../hooks/use-changes.js';
import { useProjectReads } from '../hooks/use-project-reads.js';
import { useSelection } from '../hooks/use-selection.js';
import { useService } from '../hooks/use-service.js';
import { WorkspaceCwd } from './workspace-cwd.js';

export function WorkspaceCwdView({
  services,
}: {
  readonly services: Services;
}) {
  const { project, thread } = useSelection(services);
  const panel = useService(services, LayoutPanelV1);
  // The footer's totals stay live while a Thread is shown (D10-14).
  const changes = useChanges(
    thread === undefined ? undefined : project?.id,
    thread?.cwd,
  );
  useProjectReads(thread === undefined ? undefined : project?.id);
  return (
    <div className="mr-auto flex min-w-0 flex-1 items-center gap-1">
      <WorkspaceCwd
        key={thread?.id}
        thread={thread}
        changes={changes.read}
        onShowChanges={() => panel?.show('changes')}
      />
    </div>
  );
}
