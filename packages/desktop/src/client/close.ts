// The renderer side of the close protocol (section 15.6): main drives two
// phases; the window answers with WindowHooksV1.

import type { HookHandle, WindowHooksV1 } from 'bundle/contracts';

import type { CloseAnswer, CloseRequest, DoricDesktopApi } from './protocol.js';

/** Answers one close request. */
export const answerClose = async (
  request: CloseRequest,
  windowHooks: HookHandle<typeof WindowHooksV1> | undefined,
): Promise<CloseAnswer> => {
  if (request.phase === 'close') {
    if (request.forced || windowHooks === undefined) {
      return { allow: true };
    }

    // No deadline: the core provider exempts doric.window.hooks/v1.
    const decision = await windowHooks.onCloseHook.execute({});

    return decision.allow
      ? { allow: true }
      : { allow: false, reason: decision.reason };
  }

  // Flush: the window's flush hook runs; main enforces the deadline.
  await Promise.allSettled(
    windowHooks === undefined
      ? []
      : [
          windowHooks.onFlushHook.execute(
            {},
            request.deadline > 0 ? { deadline: request.deadline } : undefined,
          ),
        ],
  );

  return { allow: true };
};

/** Wires the window's close answers; returns the unsubscribe function. */
export const wireClose = (input: {
  readonly desktop: DoricDesktopApi;
  readonly windowHooks: HookHandle<typeof WindowHooksV1> | undefined;
}): (() => void) =>
  input.desktop.onCloseRequested((request) =>
    answerClose(request, input.windowHooks),
  );
