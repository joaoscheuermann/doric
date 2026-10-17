// The `screen` bundle's host part: provides `screen.sessions/v2` over the
// session manager, and publishes each session's upstream through
// `screen.relay/v1`. The relay itself is the `screen-relay` bundle's, because
// it mounts on the host's native listeners, which only a resident bundle is
// handed; this part runs in a generation, where `runtime.lease/v1.withLease`
// can hand it the Project's sandbox.

import { type HostContext, LogV1 } from 'bundle/contracts';
import { ScreenRelayV1 } from 'screen-relay/contracts';

import { createScreenSessions, screenSessionsService } from './provider.js';

export const activate = ({ services }: HostContext) => {
  const sessions = createScreenSessions({
    log: () => services.use(LogV1),
    relay: () => services.use(ScreenRelayV1),
  });

  services.provide(screenSessionsService(sessions));

  return () => sessions.dispose();
};
