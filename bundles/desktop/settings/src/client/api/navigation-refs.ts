// The `workspace` contract the settings window reaches, as a ref by id (D32):
// the type comes from `workspace/contracts` by `import type`, so no shipped
// module of this bundle imports it, and a composition without `workspace`
// still loads the settings part (bundle isolation 4(c)).

import { ref } from 'bundle/contracts';
import type { WorkspaceDashboard } from 'workspace/contracts';

/** `workspace.dashboard/v1`, provided by `workspace`. */
export const WorkspaceDashboardV1 = ref<WorkspaceDashboard>(
  'workspace.dashboard/v1',
);
