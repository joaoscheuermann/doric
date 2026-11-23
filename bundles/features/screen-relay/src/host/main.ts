// `screen-relay`'s host part as a process (spec section 11, "The HTTP
// prefix"; phase 3, slice S49): `screen.relay/v1` through the router and the
// relay on its own loopback listener. Built into `dist/host/main.mjs`; the
// running host keeps the kernel entry (`./index.ts`) until S62, which also
// adds `host.httpPrefix: "/screen/"` to the manifest.

import { runBundle } from 'bundle/host';

import { RelayService } from '../contracts/gen/doric/screen/relay/v1/relay_pb.js';
import { createScreenRelayPart } from './part.js';

const part = createScreenRelayPart();

runBundle({
  services: [[RelayService, part.implementation]],
  httpServer: part.httpServer,
  activate: () => undefined,
  deactivate: () => part.deactivate(),
});
