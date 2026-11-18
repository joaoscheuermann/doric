// The settings bundle's client part (stage 9, design §6): the settings window
// at `/settings`, its own five sections as child routes (Versioning is the git bundle's since WP-10N), the nav as the
// `settings.sections` region, `settings.models/v1` for the chat's footer
// execution picker (bundle isolation 6(c)), the account menu's "Settings"
// entry in `account.menu` and the Dashboard's "All settings" entry in
// `workspace.dashboard.footer`, both drawn with `settings-entry-icon`.

import type { ACCOUNT_MENU, AccountMenuItemProps } from 'account/contracts';
import {
  type ClientContext,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import { ClaudeLoginV1 } from 'claude-login/contracts';
import type {
  DashboardFooterItemProps,
  WORKSPACE_DASHBOARD_FOOTER,
  WORKSPACE_DASHBOARD_NAV,
  WORKSPACE_DASHBOARD_PAGE,
} from 'workspace/contracts';

import { SETTINGS_SECTIONS } from '../contracts/index.js';
import { LayoutDashboardV1 } from './api/navigation-refs.js';
import { initSettingsApi, setDashboardAvailable } from './api/settings-api.js';
import { registerAppearanceSection } from './appearance-section.js';
import { createSectionRoute, sectionPath } from './domain/section-route.js';
import { sectionLink, sections } from './domain/sections.js';
import {
  linkHosts,
  PROVIDER_PAGE_ID,
  providerPageHosts,
  sectionHosts,
} from './elements.js';
import { setClaudeLoginAvailable } from './hooks/use-claude-login.js';
import {
  clearSettingsQueryClient,
  settingsQueryClient,
} from './queries/client.js';
import { createSettingsConfig } from './services/settings-config.js';
import { createSettingsModels } from './services/settings-models.js';
import { DashboardProvidersElement } from './views/dashboard-providers.js';
import { EntryIconElement } from './views/entry-icon.js';
import { SettingsPageElement } from './views/settings-page.js';

export function activate({ services }: ClientContext): () => void {
  initSettingsApi(services);
  // R-9.8: the window's autosave draft for sections other bundles draw.
  services.provide(createSettingsConfig());
  // The footer execution picker's data, for the chat that draws it.
  const models = createSettingsModels({
    queryClient: settingsQueryClient,
    onFocus: (listener) => {
      window.addEventListener('focus', listener);
      return {
        dispose: () => window.removeEventListener('focus', listener),
      };
    },
  });
  services.provide(models.service);

  const ui = services.use(UiV1);
  const navigation = services.use(NavigationV1);
  const regions = services.use(RegionsV1);
  const registrations = [
    ui.define('settings-page', SettingsPageElement),
    ui.define('settings-link', linkHosts.Element),
    ...sections.map((section) =>
      ui.define(`settings-${section.id}`, sectionHosts[section.id].Element),
    ),
    ui.define('settings-dashboard-providers', DashboardProvidersElement),
    ui.define('settings-dashboard-provider', providerPageHosts.Element),
    ui.define('settings-entry-icon', EntryIconElement),
    navigation.register({
      path: '/settings',
      create: () => ui.create('settings-page'),
    }),
    // Appearance registers its route and link only while the app answers
    // `doric.appearance/v1` (S35).
    ...sections
      .filter((section) => section.id !== 'appearance')
      .flatMap((section) => [
        navigation.register({
          path: sectionPath(section.id),
          parent: '/settings',
          create: () => ui.create(`settings-${section.id}`),
        }),
        regions.add(SETTINGS_SECTIONS, sectionLink(section)),
      ]),
    registerAppearanceSection({ services, ui, navigation, regions }),
    // The account menu's "Settings" entry, which opens this window.
    regions.add('account.menu' satisfies typeof ACCOUNT_MENU, {
      id: 'settings',
      tag: 'settings-entry-icon',
      props: {
        label: 'Settings',
        command: 'core.open-settings/v1',
        input: { defaultPath: '/settings' },
      } satisfies AccountMenuItemProps,
    }),
    // The Dashboard's "All settings" entry, which opens this window.
    regions.add(
      'workspace.dashboard.footer' satisfies typeof WORKSPACE_DASHBOARD_FOOTER,
      {
        id: 'settings',
        tag: 'settings-entry-icon',
        props: {
          label: 'All settings',
          command: 'core.open-settings/v1',
          input: { defaultPath: '/settings' },
        } satisfies DashboardFooterItemProps,
      },
    ),
    // The /projects dashboard's Providers group and the page it opens.
    regions.add(
      'workspace.dashboard.nav' satisfies typeof WORKSPACE_DASHBOARD_NAV,
      {
        id: 'providers',
        tag: 'settings-dashboard-providers',
        order: 100,
      },
    ),
    regions.add(
      'workspace.dashboard.page' satisfies typeof WORKSPACE_DASHBOARD_PAGE,
      {
        id: PROVIDER_PAGE_ID,
        tag: 'settings-dashboard-provider',
      },
    ),
    createSectionRoute().follow(navigation),
    // `claude.login/v1` is optional: the provider page offers the sign-in
    // only while a provider answers it.
    services.whenAvailable(ClaudeLoginV1, () => {
      setClaudeLoginAvailable(true);
      return () => setClaudeLoginAvailable(false);
    }),
    // `layout.dashboard/v1` is optional too: without the workspace's dashboard
    // the Providers group has nowhere to open its page.
    services.whenAvailable(LayoutDashboardV1, () => {
      setDashboardAvailable(true);
      return () => setDashboardAvailable(false);
    }),
  ];

  return () => {
    for (const registration of registrations.reverse()) registration.dispose();
    models.dispose();
    clearSettingsQueryClient();
    initSettingsApi(undefined);
  };
}
