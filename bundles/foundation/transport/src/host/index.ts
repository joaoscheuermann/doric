import { DoricNetworkV1, type HostContext } from 'bundle/contracts';
import type { Express } from 'express';
import type { Server } from 'socket.io';

import { createTransport } from '../kernel.js';

/** Register product routes on native listeners, without host knowledge of their APIs. */
export const activate = ({ services }: HostContext) => {
  const registration = services
    .use(DoricNetworkV1)
    .register(({ http, sockets }) => {
      const transport = createTransport({
        app: http as Express,
        io: sockets as Server,
      });
      return transport.host.activate({ services });
    });
  return () => registration.dispose();
};
