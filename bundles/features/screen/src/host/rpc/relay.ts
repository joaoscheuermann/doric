// `screen.relay/v1` as the `ScreenRelayPublisher` the sessions publish on,
// for the router path (phase 3, slice S49): each exposed token is a tracked
// registration, so a new `screen-relay` instance serves it again.

import type { HostContext, TrackedRegistration } from 'bundle/host';
import { RelayService } from 'screen-relay/contracts/gen/doric/screen/relay/v1/relay_pb.js';

import type { ScreenRelayPublisher } from '../provider.js';
import { routedError } from './lease.js';

/**
 * A `ScreenRelayPublisher` over `screen.relay/v1` whose exposed tokens
 * survive a new `screen-relay` instance (a crash, an upgrade).
 *
 * - `expose(input)` calls `Expose(input)` through
 *   `context.registrations.track(RelayService, …)` and resolves when it
 *   answered; it first untracks a live registration of the same token. The
 *   SDK replays every live one to each new provider instance
 *   (`ProviderChanged`), so the new relay serves the same tokens.
 * - `forget({ token })` untracks the token's registration, then calls
 *   `Forget({ token })` (`context.services.use(RelayService)`).
 *
 * Rejects with the relay call's failure as `fromConnectError` reads it
 * (`expose` then tracks nothing). Calls inherit the handler's call
 * (`currentCall()`); replays run outside any call.
 */
export const trackedRelay = (
  context: Pick<HostContext, 'registrations' | 'services'>,
): ScreenRelayPublisher => {
  const tracked = new Map<string, TrackedRegistration<unknown>>();
  const relay = context.services.use(RelayService);

  const untrack = (token: string): void => {
    tracked.get(token)?.untrack();
    tracked.delete(token);
  };

  return {
    expose: async ({ token, host, port }) => {
      untrack(token);

      try {
        const registration = await context.registrations.track(
          RelayService,
          (client) => client.expose({ token, host, port }),
        );

        tracked.set(token, registration);

        return registration.current;
      } catch (error) {
        throw routedError(error);
      }
    },
    forget: async ({ token }) => {
      untrack(token);

      try {
        return await relay.forget({ token });
      } catch (error) {
        throw routedError(error);
      }
    },
  };
};
