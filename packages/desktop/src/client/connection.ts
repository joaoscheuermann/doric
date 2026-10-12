// `doric.connection/v1` (stage 9, D9-5): the host connection status of the
// window, fed by main's `doric.shell/v1.connection` stream. It starts as
// `disconnected` until main reports, and listeners hear only changes — the
// same contract as the preload's `connection` mirror it replaces.

import {
  type ConnectionStatus,
  connectionStatusSchema,
  type Disposable,
  DoricConnectionV1,
  defineMethod,
} from 'bundle/contracts';
import {
  definePlatformService,
  type Principal,
  platformContracts,
} from 'bundle/runtime';

import { shellStream } from './bridge.js';
import type { DoricDesktopApi } from './protocol.js';

/**
 * Registers `doric.connection/v1` under the window platform principal and
 * subscribes to main's status stream; returns that subscription.
 */
export const provideConnection = (
  platform: Principal,
  desktop: DoricDesktopApi,
): Disposable => {
  const methods = platformContracts['doric.connection/v1'].methods;
  const listeners = new Set<(status: ConnectionStatus) => void>();
  let current: ConnectionStatus = 'disconnected';

  platform.services.provide(
    definePlatformService(DoricConnectionV1, {
      status: defineMethod({
        input: methods.status.input,
        output: methods.status.output,
        execute: () => current,
      }),
      subscribe: defineMethod({
        input: methods.subscribe.input,
        output: methods.subscribe.output,
        execute: (listener: (status: ConnectionStatus) => void) => {
          listeners.add(listener);

          return { dispose: () => listeners.delete(listener) };
        },
      }),
    }),
  );

  return shellStream<unknown>(desktop, 'connection', (item) => {
    const parsed = connectionStatusSchema.safeParse(item);

    if (!parsed.success || parsed.data === current) {
      return;
    }

    current = parsed.data;

    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch {
        // One listener's failure does not keep the others from the change.
      }
    }
  });
};
