// The core's client part (stage 9, §4): the window's hooks, log, ui,
// navigation, regions and commands, the four structural elements, same-origin
// link interception and the menu context of the window path. Each `provide`
// is inert when the composition chose another provider for that contract.

import {
  type Cleanup,
  type ClientContext,
  LogV1,
  MenusV1,
  NavigationV1,
  UiV1,
} from 'bundle/contracts';

import { createHooks } from '../shared/hooks.js';
import { createLog } from '../shared/log.js';
import { createCommands } from './commands.js';
import { setCoreServices } from './core-services.js';
import { CoreNotFound } from './elements/not-found.js';
import { CoreOutlet } from './elements/outlet.js';
import { CoreRegion } from './elements/region.js';
import { CoreUnavailable } from './elements/unavailable.js';
import { interceptLinks } from './links.js';
import { reportMenuContext } from './menu-context.js';
import { createNavigation } from './navigation.js';
import { createRegions } from './regions.js';
import { createUi } from './ui.js';

export function activate({ services }: ClientContext): Cleanup {
  services.provide(createHooks());
  services.provide(createLog({ redact: false }));
  services.provide(createUi());
  services.provide(createNavigation());
  services.provide(createRegions());
  services.provide(createCommands());
  setCoreServices(services);

  const ui = services.use(UiV1);

  ui.define('core-outlet', CoreOutlet);
  ui.define('core-region', CoreRegion);
  ui.define('core-not-found', CoreNotFound);
  ui.define('core-unavailable', CoreUnavailable);

  const navigation = services.use(NavigationV1);
  const links = interceptLinks(navigation);
  // menus/v1 is the core's own desktopMain contract: no `requires` entry.
  const context = reportMenuContext(
    navigation,
    services.use(MenusV1),
    services.use(LogV1),
  );

  return () => {
    context.dispose();
    links.dispose();
    setCoreServices(undefined);
  };
}
