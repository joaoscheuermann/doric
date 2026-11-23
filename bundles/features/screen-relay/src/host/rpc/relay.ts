// `screen.relay/v1` through the router (phase 3, slice S49): the relay's
// `expose` and `forget` as `RelayService`'s implementation.

import type { ServiceImpl } from '@connectrpc/connect';

import type { RelayService } from '../../contracts/gen/doric/screen/relay/v1/relay_pb.js';
import type { ScreenRelayServer } from '../relay.js';

/**
 * `screen.relay/v1` over one relay, served through the router.
 *
 * - `Expose({ token, host, port })` registers, or replaces, the token's
 *   upstream and answers `{}` once the relay serves it: a request sent after
 *   the answer is forwarded to that upstream.
 * - `Forget({ token })` drops the token and answers `{}`; requests under it
 *   answer 404 afterwards; an unknown token is a no-op.
 *
 * Input is validated by protovalidate before the handler runs (SDK and test
 * router): an empty `token` or `host`, or a `port` outside 1..65535, fails
 * `INVALID_ARGUMENT` `invalid_input` and changes nothing. No other failure.
 * Any caller may expose or forget any token: the token is the only
 * capability, as today (AGENTS.md of the bundle).
 */
export const relayServiceOf = (
  relay: ScreenRelayServer,
): ServiceImpl<typeof RelayService> => ({
  // Replacing a token's upstream with the same one is a no-op for the relay,
  // so a replayed `Expose` resolves again and keeps open upgrades.
  expose: ({ token, host, port }) => {
    relay.expose(token, { host, port });

    return {};
  },
  forget: ({ token }) => {
    relay.forget(token);

    return {};
  },
});
