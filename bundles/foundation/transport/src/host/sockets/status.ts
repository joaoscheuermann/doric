import type { Server } from 'socket.io';

export const registerStatusSocket = (io: Server): void => {
  io.of('/status');
};
