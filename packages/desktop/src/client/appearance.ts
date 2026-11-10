// `doric.appearance/v1`: the window asks main for the theme preference and
// saves a new one through `doric.shell/v1` (`appearanceGet`, `appearanceSet`).
// Main checks the theme again, writes `appearance.json` and repaints every
// window; the window itself holds no preference.

import {
  DoricAppearanceV1,
  type DoricTheme,
  defineMethod,
} from 'bundle/contracts';
import {
  definePlatformService,
  type Principal,
  platformContracts,
} from 'bundle/runtime';

import { shellCall } from './bridge.js';
import type { DoricDesktopApi } from './protocol.js';

/** Registers `doric.appearance/v1` under the window platform principal. */
export const provideAppearance = (
  platform: Principal,
  desktop: DoricDesktopApi,
): void => {
  const { get, set } = platformContracts['doric.appearance/v1'].methods;

  platform.services.provide(
    definePlatformService(DoricAppearanceV1, {
      get: defineMethod({
        input: get.input,
        output: get.output,
        execute: async () =>
          (await shellCall(desktop, 'appearanceGet', {})) as {
            readonly theme: DoricTheme;
          },
      }),
      set: defineMethod({
        input: set.input,
        output: set.output,
        execute: async ({ theme }: { readonly theme: DoricTheme }) => {
          await shellCall(desktop, 'appearanceSet', { theme });
        },
      }),
    }),
  );
};
