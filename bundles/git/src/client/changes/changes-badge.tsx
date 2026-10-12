// <git-changes-badge> (stage 10, §3.8): the line totals the Changes view's
// trigger in the panel's "Project views" strip shows once the changes of the
// selected Project and working directory are read, else nothing
// (`project-files-sidebar.tsx:110-115`).

import type { Services } from 'bundle/contracts';

import { useChanges } from '../hooks/use-changes.js';
import { useSelection } from '../hooks/use-selection.js';
import { changedLineTotals } from '../reads/change-tree.js';
import { ChangeCounts } from './change-counts.js';

export function ChangesBadge({ services }: { readonly services: Services }) {
  const { project, thread } = useSelection(services);
  const changes = useChanges(project?.id, thread?.cwd);
  if (changes.read.status !== 'ready') return null;
  return (
    <ChangeCounts {...changedLineTotals(changes.read.value.repositories)} />
  );
}
