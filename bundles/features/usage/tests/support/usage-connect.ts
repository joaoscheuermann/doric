// `usage/v1` as the window reaches it from slice S65d: the generated
// `UsageService` over Connect, served by a fake `HostClients` (`./connect.js`)
// whose implementation a test names. The implementation receives the call's
// `timeoutMs`, which is the only place the deadline the client part sends is
// visible.

import type { ServiceImpl } from '@connectrpc/connect';
import type { ClientServices, ProviderInfo } from 'bundle/contracts';

import { UsageService } from '../../src/contracts/gen/doric/usage/v1/usage_pb.js';
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
  implementation: Partial<ServiceImpl<typeof UsageService>>,
): Partial<ServiceImpl<typeof UsageService>> => {
  const handlers: Record<string, unknown> = { ...implementation };

  for (const rpc of UsageService.methods) {
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

  return handlers as Partial<ServiceImpl<typeof UsageService>>;
};

/**
 * The usage client part's window services: `services.use(UsageService)` and
 * `whenAvailable(UsageService)` reach `implementation` over Connect as the part
 * `usage`. `provider` lists the contract in the window's generation, so
 * `whenAvailable` calls back once.
 */
export const usageWindow = (
  implementation: Partial<ServiceImpl<typeof UsageService>>,
): { readonly services: ClientServices; readonly calls: HostCall[] } => {
  const { hostClients, calls } = fakeHostClients((router) => {
    router.service(UsageService, answeredOver(implementation));
  });
  const provider: ProviderInfo = { bundleId: 'usage', version: '1.0.0' };
  const { services } = fakeClientServices({
    bundleId: 'usage',
    hostClients,
    providers: [{ id: 'usage/v1', info: provider }],
  });

  return { services, calls };
};
