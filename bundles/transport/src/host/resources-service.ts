import { defineMethod, defineService } from 'bundle/contracts';
import { ResourcesV1, resourcesMethods } from 'resources/contracts';

import type { HostResources } from './resources.js';

/** The contract the transport provides in stage 9 (WP-H), with its version. */
export const resourcesContract = { id: ResourcesV1.id, version: '1.0.0' };

/**
 * `resources/v1.host()`: the `GET /resources` reading as a contract answer
 * (stage 9 WP-H), over the same reader the route uses, so the route and a
 * desktop window share the one CPU sample the process keeps.
 */
export const resourcesService = (read: () => HostResources) =>
  defineService(ResourcesV1, {
    host: defineMethod({
      ...resourcesMethods.host,
      execute: async () => read(),
    }),
  });
