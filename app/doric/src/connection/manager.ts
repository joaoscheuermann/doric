import { Manager } from 'socket.io-client';

import { workspaceUrl } from '../workspace/config';

/**
 * One connection manager for the workspace host, over the websocket transport:
 * every namespace opened on it shares that Manager's one Engine.IO connection.
 * The status and Project tree namespaces share the process-long manager;
 * `createThreadEventService` is given this factory so that each watched Thread
 * gets a manager of its own, whose connection — and the subscription the host
 * holds on it — ends with that watch.
 */
export const createConnectionManager = (): Manager =>
  new Manager(workspaceUrl, {
    transports: ['websocket'],
    reconnection: true,
  });
