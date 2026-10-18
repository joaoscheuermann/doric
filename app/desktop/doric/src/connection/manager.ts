import { Manager } from 'socket.io-client';

/**
 * The connection manager of the host's `/status` monitor, over the websocket
 * transport, for the host at `hostUrl` — the same origin the platform's
 * bridge reaches. Every window follows that status through
 * `doric.shell/v1.connection`.
 */
export const createConnectionManager = (hostUrl: string): Manager =>
  new Manager(hostUrl, {
    transports: ['websocket'],
    reconnection: true,
  });
