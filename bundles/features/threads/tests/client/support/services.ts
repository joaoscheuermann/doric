// A stand-in for the `Services` the threads client part and its elements
// receive (as `default` has it): every contract the test serves is available
// at once, keyed by its contract id. `whenAvailable` runs its callback at once
// for a served contract and keeps what the callback throws, as the platform
// records it (`when_available_failed`) instead of failing the activation.

import type {
  AnyServiceRef,
  ApiOf,
  Disposable,
  Services,
} from 'bundle/contracts';

const disposed: Disposable = { dispose: () => undefined };

const provider = { bundleId: 'tests', version: '0.0.0' };

/** Services over fixed APIs, and the failures their callbacks threw. */
export const fakeServices = (
  apis: Readonly<Record<string, unknown>> = {},
): { readonly services: Services; readonly failures: readonly unknown[] } => {
  const failures: unknown[] = [];
  const services: Services = {
    provide: () => disposed,
    use: <R extends AnyServiceRef>(contract: R) => {
      const api = apis[contract.id];
      if (api === undefined) {
        throw new Error(`The test does not serve ${contract.id}.`);
      }
      return api as ApiOf<R>;
    },
    whenAvailable: (contract, callback) => {
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
  };
  return { services, failures };
};
