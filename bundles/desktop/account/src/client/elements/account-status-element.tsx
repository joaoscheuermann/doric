// `account-status` (`shell.window.actions`): the account button, its menu and
// the `account.status` badges, rendered with the services of the bundle that
// created the element.

import { defineReactElement } from 'desktop/ui/react-element';

import { AccountStatus } from '../components/organisms/account-status.js';

export const AccountStatusElement = defineReactElement({
  props: [],
  render: AccountStatus,
});
