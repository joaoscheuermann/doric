// A stand-in for the `Services` the claude-login element receives from its
// owner: every contract the test serves is available at once, keyed by its
// contract id. `whenAvailable` runs its callback at once for a served
// contract and keeps what the callback throws, as the platform records it
// (`when_available_failed`) instead of failing the activation. A generated
// service descriptor (a host contract, slice S65c) is answered by `host`'s
// `HostClients` as the window runtime answers it: a Connect client of the
// part's window transport.

import type {
  AnyServiceRef,
  ApiOf,
  CallScope,
  ClientServices,
  Disposable,
} from 'bundle/contracts';
import type { HostClients } from 'bundle/runtime';

import { isDescService } from './connect.js';

const disposed: Disposable = { dispose: () => undefined };

const provider = { bundleId: 'tests', version: '0.0.0' };

/** Services over fixed APIs, and the failures their callbacks threw. */
export const fakeServices = (
  apis: Readonly<Record<string, unknown>> = {},
  host?: {
    readonly hostClients: HostClients;
    /** The calling part; `claude-login` by default. */
    readonly bundleId?: string;
  },
): {
  readonly services: ClientServices;
  readonly failures: readonly unknown[];
} => {
  const failures: unknown[] = [];
  const services = {
    provide: () => disposed,
    use: (contract: unknown, scope?: CallScope) => {
      if (isDescService(contract)) {
        if (host === undefined) {
          throw new Error(`The test does not serve ${contract.typeName}.`);
        }
        return host.hostClients
          .part(host.bundleId ?? 'claude-login')
          .use(contract, scope === undefined ? undefined : { scope });
      }
      const { id } = contract as AnyServiceRef;
      const api = apis[id];
      if (api === undefined) {
        throw new Error(`The test does not serve ${id}.`);
      }
      return api as ApiOf<AnyServiceRef>;
    },
    whenAvailable: (
      contract: AnyServiceRef,
      callback: (api: never, info: typeof provider) => unknown,
    ) => {
      const api = apis[contract.id];
      if (api === undefined) return disposed;
      try {
        const cleanup = callback(api as never, provider);
        return {
          dispose: () => {
            if (typeof cleanup === 'function') void cleanup();
          },
        };
      } catch (error) {
        failures.push(error);
        return disposed;
      }
    },
  } as unknown as ClientServices;
  return { services, failures };
};
