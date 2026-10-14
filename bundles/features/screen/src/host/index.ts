// The `screen` bundle's host part: provides `screen.sessions/v1` over the
// session manager and the loopback relay, both alive for this generation.

import { type HostContext, LogV1 } from 'bundle/contracts';

import { createScreenSessions, screenSessionsService } from './provider.js';

export const activate = ({ services }: HostContext) => {
  const sessions = createScreenSessions({
    log: () => services.use(LogV1),
  });

  services.provide(screenSessionsService(sessions));

  return () => sessions.dispose();
};
