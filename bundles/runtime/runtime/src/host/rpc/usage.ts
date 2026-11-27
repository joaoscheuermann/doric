// `runtime.usage/v1` over the router (phase 3, slice S46a).

import type { ServiceImpl } from '@connectrpc/connect';

import {
  ReadResponseSchema,
  type UsageService,
} from '../../contracts/gen/doric/runtime/usage/v1/usage_pb.js';
import { runtimeUsageMethods as methods } from '../../contracts/usage.js';
import type { RuntimeCore } from '../core.js';
import { encode } from './codec.js';
import { detached, parseInput, routed } from './errors.js';

/**
 * `runtime.usage/v1` over `RuntimeCore`. `core()` throws
 * `ContractError('unavailable')` before `activate`.
 */
export const routedUsageService = (
  core: () => RuntimeCore,
): ServiceImpl<typeof UsageService> => ({
  read: ({ threadId }) =>
    routed(async () => {
      const { service } = core();
      const id = parseInput(
        'runtime.usage/v1 read',
        methods.read.input,
        threadId,
      );
      return encode(ReadResponseSchema, {
        threadUsage: await detached(() => service.threads.storedUsage(id)),
      });
    }),
});
