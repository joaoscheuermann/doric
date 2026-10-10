// The renderer side of the close protocol (section 15.6): main drives two
// phases; the window answers with WindowHooksV1 and the extra flush
// participants.

import type { HookHandle, WindowHooksV1 } from 'bundle/contracts';

import type { CloseAnswer, CloseRequest, DoricDesktopApi } from './protocol.js';

export type FlushParticipants = () => readonly (() => Promise<void>)[];

/** Answers one close request. */
export const answerClose = async (
  request: CloseRequest,
  windowHooks: HookHandle<typeof WindowHooksV1> | undefined,
  flushParticipants?: FlushParticipants,
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

  // Flush: every participant runs; main enforces the deadline.
  await Promise.allSettled([
    ...(windowHooks === undefined
      ? []
      : [
          windowHooks.onFlushHook.execute(
            {},
            request.deadline > 0 ? { deadline: request.deadline } : undefined,
          ),
        ]),
    ...(flushParticipants?.() ?? []).map(async (flush) => flush()),
  ]);

  return { allow: true };
};

/** Wires the window's close answers; returns the unsubscribe function. */
export const wireClose = (input: {
  readonly desktop: DoricDesktopApi;
  readonly windowHooks: HookHandle<typeof WindowHooksV1> | undefined;
  readonly flushParticipants?: FlushParticipants;
}): (() => void) =>
  input.desktop.onCloseRequested((request) =>
    answerClose(request, input.windowHooks, input.flushParticipants),
  );
