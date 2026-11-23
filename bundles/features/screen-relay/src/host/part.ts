// `screen-relay`'s host part (phase 3, slice S49): the relay, its own loopback
// listener and `screen.relay/v1`'s implementation, as `main.ts` gives them to
// `runBundle`.

import { createServer, type Server } from 'node:http';

import type { ServiceImpl } from '@connectrpc/connect';

import type { RelayService } from '../contracts/gen/doric/screen/relay/v1/relay_pb.js';
import { createScreenRelay, type ScreenRelayServer } from './relay.js';
import { relayServiceOf } from './rpc/relay.js';

/** What `main.ts` gives `runBundle`, built once at module load. */
export interface ScreenRelayPart {
  /** The relay; holds no token at creation. */
  readonly relay: ScreenRelayServer;
  /**
   * A new `http.Server`, not listening, already served by `relay.serve`:
   * `runBundle`'s `httpServer`, which the SDK binds to `127.0.0.1:0` and
   * reports as `httpPort`. Tests bind it themselves.
   */
  readonly httpServer: Server;
  /** `relayServiceOf(relay)`: the `[RelayService, implementation]` entry. */
  readonly implementation: ServiceImpl<typeof RelayService>;
  /**
   * `deactivate`: detaches `serve` and calls `relay.dispose()`, so every
   * relayed connection, upgrades included, is destroyed; the SDK closes
   * `httpServer` afterwards. Never throws; idempotent.
   */
  deactivate(): void;
}

/** Builds the part; makes no I/O and binds nothing. */
export const createScreenRelayPart = (): ScreenRelayPart => {
  const relay = createScreenRelay();
  const httpServer = createServer();
  const detach = relay.serve(httpServer);

  return {
    relay,
    httpServer,
    implementation: relayServiceOf(relay),
    deactivate: () => {
      detach();
      relay.dispose();
    },
  };
};
