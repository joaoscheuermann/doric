import { Manager } from 'socket.io-client';

import { HOST_URL } from '../platform/bridge/host-bridge';

/**
 * The connection manager of the host's `/status` monitor, over the websocket
 * transport. Every window follows that status through
 * `doric.shell/v1.connection`.
 */
export const createConnectionManager = (): Manager =>
  new Manager(HOST_URL, {
    transports: ['websocket'],
    reconnection: true,
  });
