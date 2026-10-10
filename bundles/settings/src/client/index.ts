// The settings bundle's client part (stage 9, design §6): the settings window
// at `/settings`, its five sections as child routes, the nav as the
// `settings.sections` region, and the footer execution picker in
// `layout.footer`.

import {
  type ClientContext,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import { initSettingsApi } from './api/settings-api.js';
import { createSectionRoute, sectionPath } from './domain/section-route.js';
import { sectionLink, sections } from './domain/sections.js';
import { linkHosts, sectionHosts } from './elements.js';
import { clearSettingsQueryClient } from './queries/client.js';
import {
  ExecutionPickerElement,
  SettingsPageElement,
} from './views/settings-page.js';

export function activate({ services }: ClientContext): () => void {
  initSettingsApi(services);

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
    createSectionRoute().follow(navigation),
  ];

  return () => {
    for (const registration of registrations.reverse()) registration.dispose();
    clearSettingsQueryClient();
    initSettingsApi(undefined);
  };
}
