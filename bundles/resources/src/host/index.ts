import {
  defineMethod,
  defineService,
  type HostContext,
} from 'bundle/contracts';
import { RuntimeLeaseV1 } from 'runtime/contracts';

import { ResourcesV1, resourcesMethods } from '../contracts/index.js';
import { readSandboxResources } from './container.js';
import { readHostResources } from './machine.js';

export { readSandboxResources } from './container.js';
export { cpuPercentBetween, readHostResources } from './machine.js';

/**
 * `resources/v1` (§3.12): the host machine, read with the one CPU sample the
 * generation keeps, and the calling Project's container on the lease it
 * holds now. `withLease` never acquires, so a Project without a lease
 * answers its lease state as data.
 */
export const resourcesService = defineService(ResourcesV1, {
  host: defineMethod({
    ...resourcesMethods.host,
    execute: async () => readHostResources(),
  }),
  project: defineMethod({
    ...resourcesMethods.project,
    execute: (_input, call, services) =>
      services
        .use(RuntimeLeaseV1, call.scope)
        .withLease((sandbox) => readSandboxResources(sandbox), call),
  }),
});

export const activate = ({ services }: HostContext): void => {
  services.provide(resourcesService);
};
