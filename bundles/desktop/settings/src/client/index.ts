// The settings bundle's client part (stage 9, design §6): the settings window
// at `/settings`, its own four sections as child routes (Versioning is the git bundle's since WP-10N), the nav as the
// `settings.sections` region, and the footer execution picker in
// `layout.footer`.

import {
  type ClientContext,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import { ClaudeLoginV1 } from 'claude-login/contracts';
import { LayoutDashboardV1 } from 'layout/contracts';

import { initSettingsApi, setDashboardAvailable } from './api/settings-api.js';
import { createSectionRoute, sectionPath } from './domain/section-route.js';
import { sectionLink, sections } from './domain/sections.js';
import {
  linkHosts,
  PROVIDER_PAGE_ID,
  providerPageHosts,
  sectionHosts,
} from './elements.js';
import { setClaudeLoginAvailable } from './hooks/use-claude-login.js';
import { clearSettingsQueryClient } from './queries/client.js';
import { createSettingsConfig } from './services/settings-config.js';
import { DashboardProvidersElement } from './views/dashboard-providers.js';
import {
  ExecutionPickerElement,
  SettingsPageElement,
} from './views/settings-page.js';

export function activate({ services }: ClientContext): () => void {
  initSettingsApi(services);
  // R-9.8: the window's autosave draft for sections other bundles draw.
  services.provide(createSettingsConfig());

  const ui = services.use(UiV1);
  const navigation = services.use(NavigationV1);
  const regions = services.use(RegionsV1);
  const registrations = [
    ui.define('settings-page', SettingsPageElement),
    ui.define('settings-link', linkHosts.Element),
    ...sections.map((section) =>
      ui.define(`settings-${section.id}`, sectionHosts[section.id].Element),
    ),
    ui.define('settings-execution-picker', ExecutionPickerElement),
    ui.define('settings-dashboard-providers', DashboardProvidersElement),
    ui.define('settings-dashboard-provider', providerPageHosts.Element),
    navigation.register({
      path: '/settings',
      create: () => ui.create('settings-page'),
    }),
    ...sections.flatMap((section) => [
      navigation.register({
        path: sectionPath(section.id),
        parent: '/settings',
        create: () => ui.create(`settings-${section.id}`),
      }),
      regions.add('settings.sections', sectionLink(section)),
    ]),
    regions.add('layout.footer', {
      id: 'execution',
      tag: 'settings-execution-picker',
      order: 20,
    }),
    // The /projects dashboard's Providers group and the page it opens.
    regions.add('layout.dashboard.nav', {
      id: 'providers',
      tag: 'settings-dashboard-providers',
      order: 100,
    }),
    regions.add('layout.dashboard.page', {
      id: PROVIDER_PAGE_ID,
      tag: 'settings-dashboard-provider',
    }),
    createSectionRoute().follow(navigation),
    // `claude.login/v1` is optional: the provider page offers the sign-in
    // only while a provider answers it.
    services.whenAvailable(ClaudeLoginV1, () => {
      setClaudeLoginAvailable(true);
      return () => setClaudeLoginAvailable(false);
    }),
    // `layout.dashboard/v1` is optional too: without the layout's dashboard
    // the Providers group has nowhere to open its page.
    services.whenAvailable(LayoutDashboardV1, () => {
      setDashboardAvailable(true);
      return () => setDashboardAvailable(false);
    }),
  ];

  return () => {
    for (const registration of registrations.reverse()) registration.dispose();
    clearSettingsQueryClient();
    initSettingsApi(undefined);
  };
}
