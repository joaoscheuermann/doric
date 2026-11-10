// <git-workspace-cwd> (stage 10, §3.8): the footer's working directory and
// branch for the selected Thread, moved from the layout's provisional
// `layout-cwd` portal. It renders nothing without a Thread. The change counts
// live in the Changes tab, not here.

import type { Services } from 'bundle/contracts';

import { useProjectReads } from '../hooks/use-project-reads.js';
import { useSelection } from '../hooks/use-selection.js';
import { WorkspaceCwd } from './workspace-cwd.js';

export function WorkspaceCwdView({
  services,
}: {
  readonly services: Services;
}) {
  const { project, thread } = useSelection(services);
  useProjectReads(thread === undefined ? undefined : project?.id);
  return (
    <div className="mr-auto flex min-w-0 flex-1 items-center gap-1">
      <WorkspaceCwd key={thread?.id} thread={thread} />
    </div>
  );
}
