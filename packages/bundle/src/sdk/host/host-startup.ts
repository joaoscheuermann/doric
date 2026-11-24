// The startup record of a host part outside a start step (phase 3, slice
// S61b): what `onHostStart` hands its step, for a bundle that reports through
// `doric.startup/v1` without registering a hook (`postgres`'s `Connect`).

import { StartupService } from '../../contracts/gen/doric/platform/startup/v1/startup_pb.js';
import type { HostContext } from './context.js';
import { contractErrorOf } from './handlers.js';
import type { HostStartup } from './start.js';

/**
 * The startup record over `context.services.use(StartupService)`: `stage(name)` → `Stage{name}`,
 * `log(level, message, fields = {})` → `Log{level, message, fields}`. Each rejects with the call's `ContractError`.
 * A call made inside a handler inherits that call's scope, trace, deadline and signal. Creating it makes no call and
 * never throws. `onHostStart` hands its step this object.
 */
export const hostStartup = (
  context: Pick<HostContext, 'services'>,
): HostStartup => {
  const reported = async (request: () => Promise<unknown>): Promise<void> => {
    try {
      await request();
    } catch (error) {
      throw contractErrorOf(error);
    }
  };
  const client = () => context.services.use(StartupService);

  return {
    stage: (name) => reported(() => client().stage({ name })),
    log: (level, message, fields = {}) =>
      reported(() => client().log({ level, message, fields })),
  };
};
