// A `Services` stand-in for stories: each contract id maps to a fixture API.
// `whenAvailable` answers at once for the contracts the story serves and
// never for the others, as a window without that provider would.

import type {
  AnyServiceRef,
  ApiOf,
  Cleanup,
  ProviderInfo,
  Services,
} from 'bundle/contracts';

const provider: ProviderInfo = { bundleId: 'stories', version: '0.0.0' };

export const fakeServices = (
  apis: Readonly<Record<string, unknown>>,
): Services => ({
  provide: () => ({ dispose: () => undefined }),
  use: <R extends AnyServiceRef>(contract: R): ApiOf<R> => {
    const api = apis[contract.id];
    if (api === undefined) {
      throw new Error(`No story provider serves ${contract.id}.`);
    }
    return api as ApiOf<R>;
  },
  whenAvailable: <R extends AnyServiceRef>(
    contract: R,
    // biome-ignore lint/suspicious/noConfusingVoidType: the `Services` callback shape
    callback: (api: ApiOf<R>, provider: ProviderInfo) => void | Cleanup,
  ) => {
    const api = apis[contract.id];
    const cleanup =
      api === undefined ? undefined : callback(api as ApiOf<R>, provider);
    return {
      dispose: () => {
        if (typeof cleanup === 'function') cleanup();
      },
    };
  },
});
