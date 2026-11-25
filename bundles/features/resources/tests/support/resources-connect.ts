// `resources/v1` as the window reaches it from slice S65d: the generated
// `ResourcesService` over Connect, served by a fake `HostClients`
// (`./connect.js`) whose implementation a test names; the calls the client
// part made and their `doric-scope-bin` are what the test reads.

import type { ServiceImpl } from '@connectrpc/connect';
import type { ClientServices } from 'bundle/contracts';

import { ResourcesService } from '../../src/contracts/gen/doric/resources/v1/resources_pb.js';
import {
  connectFailure,
  fakeClientServices,
  fakeHostClients,
  type HostCall,
} from './connect.js';

/** Runs `answer`; a failure fails the call as the host sends it. */
const answered = async <T>(answer: () => Promise<T>): Promise<T> => {
  try {
    return await answer();
  } catch (error) {
    throw connectFailure(error);
  }
};

/** Every unary handler of `implementation`, failing its call as the host does. */
const answeredOver = (
  implementation: Partial<ServiceImpl<typeof ResourcesService>>,
): Partial<ServiceImpl<typeof ResourcesService>> => {
  const handlers: Record<string, unknown> = { ...implementation };

  for (const rpc of ResourcesService.methods) {
    if (rpc.methodKind !== 'unary') continue;

    const handler = handlers[rpc.localName];

    if (typeof handler !== 'function') continue;

    handlers[rpc.localName] = (request: unknown, context: unknown) =>
      answered(async () =>
        (handler as (request: unknown, context: unknown) => unknown)(
          request,
          context,
        ),
      );
  }

  return handlers as Partial<ServiceImpl<typeof ResourcesService>>;
};

/**
 * The resources client part's window services: `services.use(ResourcesService,
 * scope)` reaches `implementation` over Connect as the part `resources`.
 */
export const resourcesWindow = (
  implementation: Partial<ServiceImpl<typeof ResourcesService>>,
): { readonly services: ClientServices; readonly calls: HostCall[] } => {
  const { hostClients, calls } = fakeHostClients((router) => {
    router.service(ResourcesService, answeredOver(implementation));
  });
  const { services } = fakeClientServices({
    bundleId: 'resources',
    hostClients,
  });

  return { services, calls };
};
