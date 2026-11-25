// `files/v1` as the window reaches it from slice S65d: the generated
// `FilesService` over Connect, served by a fake `HostClients` (`./connect.js`)
// whose implementation a test names. The fake records every call the client
// part made, with the `doric-scope-bin` it sent, and answers what the test's
// implementation answers; a failure it throws is sent as the host sends it.

import type { ServiceImpl } from '@connectrpc/connect';
import type { ClientServices } from 'bundle/contracts';

import { FilesService } from '../../src/contracts/gen/doric/files/v1/files_pb.js';
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
  implementation: Partial<ServiceImpl<typeof FilesService>>,
): Partial<ServiceImpl<typeof FilesService>> => {
  const handlers: Record<string, unknown> = { ...implementation };

  for (const rpc of FilesService.methods) {
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

  return handlers as Partial<ServiceImpl<typeof FilesService>>;
};

/**
 * The files client part's window services: `services.use(FilesService, scope)`
 * reaches `implementation` over Connect as the part `files`; `calls` are the
 * window's host calls, in order.
 */
export const filesWindow = (
  implementation: Partial<ServiceImpl<typeof FilesService>>,
): { readonly services: ClientServices; readonly calls: HostCall[] } => {
  const { hostClients, calls } = fakeHostClients((router) => {
    router.service(FilesService, answeredOver(implementation));
  });

  return {
    services: fakeClientServices({ bundleId: 'files', hostClients }).services,
    calls,
  };
};
