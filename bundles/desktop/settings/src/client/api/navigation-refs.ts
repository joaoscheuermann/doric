// The `workspace` contract the settings window reaches, as a ref by id (D32):
// the type comes from `workspace/contracts` by `import type`, so no shipped
// module of this bundle imports it, and a composition without `workspace`
// still loads the settings part (bundle isolation 4(c)).

import { ref } from 'bundle/contracts';
import type { LayoutDashboard } from 'workspace/contracts';

/** `layout.dashboard/v1`, provided by `workspace` until step 4(e). */
export const LayoutDashboardV1 = ref<LayoutDashboard>('layout.dashboard/v1');
