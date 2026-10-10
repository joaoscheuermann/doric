import {
  AppHooksV1,
  CommandsV1,
  type DesktopContext,
  DoricMenusV1,
  DoricWindowsV1,
  HooksV1,
} from 'bundle/contracts';

import { CoreHooksV1 } from '../contracts/index.js';
import { createHooks, type HooksOptions } from '../shared/hooks.js';
import { createLog } from '../shared/log.js';
import { createCoreState } from '../shared/state.js';
import { WORKSPACE_APPEARANCE } from './appearance.js';
import { createCommands, openSettings } from './commands.js';
import { createCommandsBridge } from './commands-bridge.js';
import { defaultMenuSkeleton } from './menu.js';
import { coreMenus } from './menus.js';
import { createDesktopSettings } from './settings.js';
import { coreWindows } from './windows.js';

export interface DesktopCoreOptions {
  readonly hooks?: HooksOptions;
  /** The clock of `settings/v1` write times (epoch ms); `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * The core's desktopMain part with its options. Each `provide` is inert when
 * the composition chose another provider for that contract; the core then
 * uses the chosen one. Activation does no I/O.
 */
export const createActivate =
  (options: DesktopCoreOptions = {}) =>
  ({ services }: DesktopContext): void => {
    const state = createCoreState(
      options.now === undefined ? {} : { now: options.now },
    );

    services.provide(createHooks(options.hooks));
    services.provide(createLog());
    services.provide(createDesktopSettings(state));
    services.provide(createCommands());
    services.provide(createCommandsBridge());
    services.provide(coreWindows);
    services.provide(coreMenus);

    const hooks = services.use(HooksV1);

    hooks.define(CoreHooksV1);
    services.use(CommandsV1).register(openSettings);

    const nativeWindows = services.use(DoricWindowsV1);
    const app = hooks.use(AppHooksV1);

    // The menu skeleton and the first window wait for the app to be ready.
    app.onAppReadyHook(async (_input, call) => {
      await services.use(DoricMenusV1).setSkeleton(defaultMenuSkeleton, call);

      const path = (await nativeWindows.lastPath('workspace', call)) ?? '/';

      await nativeWindows.open(
        { key: 'workspace', path, appearance: WORKSPACE_APPEARANCE },
        call,
      );
    });
    app.onAppActivateHook(async (_input, call) => {
      await nativeWindows.focusOrOpen('workspace', call);
    });
  };

/**
 * Provides the core's desktop services (hooks, log, local settings,
 * commands, the client commands bridge, windows and menus), defines `core.hooks/v1`, registers
 * `core.open-settings/v1`, and opens the workspace window once the app is
 * ready.
 */
export const activate = createActivate();
