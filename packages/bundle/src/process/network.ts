import { defineMethod, definePlatformService } from '../contracts/define.js';
import {
  DoricNetworkV1,
  type NetworkListener,
  type NetworkResources,
  networkMethods,
} from '../contracts/network.js';
import type { Principal } from '../runtime/principal.js';

/** Native resources are reachable only by bundles resident in this process. */
export const provideNetwork = (
  platform: Principal,
  resources: NetworkResources,
): void => {
  platform.services.provide(
    definePlatformService(DoricNetworkV1, {
      register: defineMethod({
        ...networkMethods.register,
        execute: (listener: NetworkListener) => {
          const cleanup = listener(resources);
          let released = false;
          return {
            dispose: () => {
              if (released) return;
              released = true;
              cleanup?.();
            },
          };
        },
      }),
    }),
  );
};
