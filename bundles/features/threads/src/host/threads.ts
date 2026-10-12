import type { Call, Services } from 'bundle/contracts';
import { type RuntimeThreads, RuntimeThreadsV1 } from 'runtime/contracts';

/** The direct-child controls of the prompt that `call` belongs to. */
export const threadsOf = (services: Services, call: Call): RuntimeThreads =>
  services.use(RuntimeThreadsV1, call.scope);
