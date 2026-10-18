// The `screen-relay` bundle's host part: mounts the relay on the host's shared
// router and `http.Server` and provides `screen.relay/v1` so the `screen`
// bundle, in a generation, can publish each session's upstream. The composition
// runs this bundle resident, which is what makes the native listeners
// reachable at all.

import { DoricNetworkV1, type HostContext } from 'bundle/contracts';

import { createScreenRelay } from './relay.js';
import { screenRelayService } from './service.js';

export const activate = ({ services }: HostContext) => {
  const relay = createScreenRelay();
  // The relay is served by the host's shared router and `http.Server`; the
  // registration is dropped, and the relay disposed, when the bundle
  // deactivates.
  const registration = services
    .use(DoricNetworkV1)
    .register(({ http, server }) => relay.mount({ http, server }));

  services.provide(screenRelayService(relay));

  return () => {
    registration.dispose();

    relay.dispose();
  };
};
