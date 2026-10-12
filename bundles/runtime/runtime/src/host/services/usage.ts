import { defineMethod, defineService } from 'bundle/contracts';

import {
  runtimeUsageMethods as methods,
  RuntimeUsageV1,
} from '../../contracts/usage.js';
import type { WorkspaceService } from '../domain/types.js';

/** runtime.usage/v1 (1.0.0): the stored usage projection, unfilled. */
export const usageService = (service: WorkspaceService) =>
  defineService(RuntimeUsageV1, {
    read: defineMethod({
      ...methods.read,
      execute: (threadId) => service.threads.storedUsage(threadId),
    }),
  });
