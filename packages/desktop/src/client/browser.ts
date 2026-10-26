// `doric.browser/v1`: the window asks main to open an https page in the
// system browser, through `doric.shell/v1.openExternal`. The window itself
// may not open windows; main checks the URL again before the OS sees it.

import { DoricBrowserV1, defineMethod } from 'bundle/contracts';
import {
  definePlatformService,
  type Principal,
  platformContracts,
} from 'bundle/runtime';

import { shellCall } from './bridge.js';
import type { DoricDesktopApi } from './protocol.js';

/** Registers `doric.browser/v1` under the window platform principal. */
export const provideBrowser = (
  platform: Principal,
  desktop: DoricDesktopApi,
): void => {
  const { open } = platformContracts['doric.browser/v1'].methods;

  platform.services.provide(
    definePlatformService(DoricBrowserV1, {
      open: defineMethod({
        input: open.input,
        output: open.output,
        execute: async (url: string) => {
          await shellCall(desktop, 'openExternal', { url });
        },
      }),
    }),
  );
};
