// The call scope the runtime owns (M1): the Project, Thread and prompt a call
// acts on. The platform transports `CallScope` as an opaque bounded record;
// only the runtime and the bundles that call it read these three keys, through
// these helpers, so the names live with their owner.

import type { CallScope } from 'bundle/contracts';

/** The Project, Thread and prompt a runtime call is scoped to. */
export interface RuntimeScope {
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly promptId?: string | undefined;
}

/**
 * The `CallScope` naming the given runtime keys; absent keys are left out, so
 * the result is what `use(contract, scope)` binds.
 */
export const runtimeScope = (scope: RuntimeScope): CallScope => {
  const picked: Record<string, string> = {};

  if (scope.projectId !== undefined) picked.projectId = scope.projectId;
  if (scope.threadId !== undefined) picked.threadId = scope.threadId;
  if (scope.promptId !== undefined) picked.promptId = scope.promptId;

  return picked;
};

/** The runtime keys of the scope a call carries; absent keys are undefined. */
export const readRuntimeScope = (call: {
  readonly scope?: CallScope | undefined;
}): RuntimeScope => {
  const scope = call.scope ?? {};

  return {
    projectId: scope.projectId,
    threadId: scope.threadId,
    promptId: scope.promptId,
  };
};
