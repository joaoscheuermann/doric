import { type CallArg, defineHook, defineHooks, ref } from 'bundle/contracts';
import { z } from 'zod';

import type { LeaseOutcome } from '../contracts/lease.js';
import type { ContainerResources } from '../contracts/model.js';

/*
 * The `resources` bundle's contract, built from its ID with the local shape
 * this bundle calls (the way `terminal` reaches the runtime): `resources`
 * imports `runtime/contracts`, so importing `resources/contracts` here would
 * close a cycle between the two projects.
 */

/** `resources/v1`, for `project` only. */
export interface ProjectResourcesReader {
  /**
   * The container of the Project of `call.scope.projectId`, on the lease it
   * holds now (never acquiring one).
   */
  project(call?: CallArg): Promise<LeaseOutcome<ContainerResources>>;
}

export const ResourcesV1 = ref<ProjectResourcesReader>('resources/v1');

/*
 * The core's `core.event-hooks/v1`, rebuilt from its ID with the shape this
 * bundle observes, as `terminal` rebuilds `runtime.hooks/v1`: the runtime
 * takes no package dependency on the core.
 */

/** `core.event-hooks/v1`: fired after `events/v1.append` committed a row. */
export const CoreEventHooksV1 = defineHooks('core.event-hooks/v1', {
  onEventAppendedHook: defineHook({
    kind: 'observe',
    input: z.object({ stream: z.string(), type: z.string() }).strict(),
  }),
});
