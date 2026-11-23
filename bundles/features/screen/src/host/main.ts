// `screen`'s host part as a process (spec "Sandbox leases"; phase 3, slice
// S49): `screen.sessions/v2` through the router, on `runtime.lease/v1`
// operations and `screen.relay/v1`. Built into `dist/host/main.mjs`; the
// running host keeps the kernel entry (`./index.ts`) until S62.
// `screen.views/v1` (desktopMain) moves in phase 5.

import { runBundle } from 'bundle/host';

import { SessionsService } from '../contracts/gen/doric/screen/sessions/v2/sessions_pb.js';
import { createScreenSessionsService } from './rpc/sessions.js';

const sessions = createScreenSessionsService();

runBundle({
  services: [[SessionsService, sessions.implementation]],
  activate: (context) => sessions.activate(context),
  deactivate: () => sessions.deactivate(),
});
