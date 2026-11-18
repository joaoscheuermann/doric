// The account's client part (bundle isolation 4(b), spec §7): it defines
// `<account-status>`, adds it to the shell's `shell.window.actions` slot, and
// follows `doric.about/v1` for the version the menu's About line shows.
// `account.status` holds the badges over the avatar (`resources`), and
// `account.menu` the menu's entries (`settings`).

import {
  type Cleanup,
  type ClientContext,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import type { SHELL_WINDOW_ACTIONS } from 'layout/contracts';

import { followAbout } from './domain/about.js';
import { AccountStatusElement } from './elements/account-status-element.js';
import { resetMenuReports } from './hooks/use-menu-items.js';

export function activate({ services }: ClientContext): Cleanup {
  const about = followAbout(services);
  const definition = services
    .use(UiV1)
    .define('account-status', AccountStatusElement);
  const item = services
    .use(RegionsV1)
    .add('shell.window.actions' satisfies typeof SHELL_WINDOW_ACTIONS, {
      id: 'account',
      tag: 'account-status',
    });

  return () => {
    item.dispose();
    definition.dispose();
    about.dispose();
    resetMenuReports();
  };
}
