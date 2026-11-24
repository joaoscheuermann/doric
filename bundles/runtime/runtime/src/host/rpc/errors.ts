// Domain errors at the router edge (phase 3, slice S46a): the browser-safe
// helpers live in `src/contracts/routed-errors.ts` (S62b); `detached`, the
// one helper that needs `node:async_hooks`, stays here.

import { AsyncLocalStorage } from 'node:async_hooks';

export {
  parseInput,
  routed,
  routedError,
  SHUTTING_DOWN,
  THREAD_CONTROL_INACTIVE,
} from '../../contracts/routed-errors.js';

/** The asynchronous context at load: outside every handler's call. */
const outside = AsyncLocalStorage.snapshot();

/**
 * Runs `work` outside the call whose handler is running, as the kernel ran the
 * domain: the work the domain starts and leaves running (a Project's
 * acquisition, a resumed prompt) does not inherit the request's signal,
 * deadline or scope, so it outlives the call that started it.
 */
export const detached = <T>(work: () => T): T => outside(work);
