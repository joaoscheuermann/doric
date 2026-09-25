import { Manager } from 'socket.io-client';

import { workspaceUrl } from '../workspace/config';

/** Owns the one process-long Engine.IO connection shared by all namespaces. */
export const createConnectionManager = (): Manager =>
  new Manager(workspaceUrl, {
    transports: ['websocket'],
    reconnection: true,
  });
