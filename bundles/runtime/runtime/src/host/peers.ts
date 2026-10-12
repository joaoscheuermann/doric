import { type CallArg, ref } from 'bundle/contracts';

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
