// The `screen` bundle's host part: provides `screen.sessions/v2` over the
// session manager, and mounts the relay on the host's own origin through
// `doric.network/v1`. Both live for this generation.

import { DoricNetworkV1, type HostContext, LogV1 } from 'bundle/contracts';

import { createScreenSessions, screenSessionsService } from './provider.js';

export const activate = ({ services }: HostContext) => {
  const sessions = createScreenSessions({
    log: () => services.use(LogV1),
  });
  // The relay is served by the host's shared router and `http.Server`; the
  // registration is dropped, and the relay disposed, when the bundle
  // deactivates.
  const registration = services
    .use(DoricNetworkV1)
    .register(({ http, server }) => sessions.mount({ http, server }));

  services.provide(screenSessionsService(sessions));

  return () => {
    registration.dispose();

    return sessions.dispose();
  };
};
