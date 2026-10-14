// `screen.relay/v1` over one relay: the contract the `screen` bundle, in a
// generation, calls to publish and drop the upstream of a session token. The
// relay itself owns the paths, the HTTP forwarding and the upgrade.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  type ScreenRelayExpose,
  type ScreenRelayForget,
  ScreenRelayV1,
  screenRelayMethods,
} from '../contracts/index.js';
import type { ScreenRelayServer } from './relay.js';

/** The `screen.relay/v1` definition over one relay. */
export const screenRelayService = (relay: ScreenRelayServer) =>
  defineService(ScreenRelayV1, {
    // Both methods answer a promise because the caller crosses a process when
    // it publishes: the `screen` bundle awaits the answer so a window never
    // loads a path the relay has not accepted yet. The relay itself is
    // synchronous.
    expose: defineMethod({
      ...screenRelayMethods.expose,
      execute: (input: ScreenRelayExpose) => {
        relay.expose(input.token, { host: input.host, port: input.port });

        return Promise.resolve();
      },
    }),
    forget: defineMethod({
      ...screenRelayMethods.forget,
      execute: (input: ScreenRelayForget) => {
        relay.forget(input.token);

        return Promise.resolve();
      },
    }),
  });
