// `doric.appearance/v1`: the window asks main for the appearance preference
// (the theme and the frosted glass) and saves a new one through
// `doric.shell/v1` (`appearanceGet`, `appearanceSet`). Main checks the input
// again, writes `appearance.json` and shows it in every window; the window
// itself holds no preference.

import {
  type DoricAppearance,
  DoricAppearanceV1,
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
          (await shellCall(desktop, 'appearanceGet', {})) as Awaited<
            ReturnType<DoricAppearance['get']>
          >,
      }),
      set: defineMethod({
        input: set.input,
        output: set.output,
        execute: async (input: Parameters<DoricAppearance['set']>[0]) => {
          await shellCall(desktop, 'appearanceSet', input);
        },
      }),
    }),
  );
};
