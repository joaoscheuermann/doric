import { createElement, useState } from 'react';

import { sectionPath } from '../../src/client/domain/section-route.js';
import {
  clearSettingsQueryClient,
  settingsQueryClient,
} from '../../src/client/queries/client.js';
import {
  ExecutionPickerElement,
  SettingsPageElement,
} from '../../src/client/views/settings-page.js';
import { defineSettingsElements } from '../support/core.js';
import { footerFrame, windowFrame } from '../support/frames.js';
import {
  bindStoryServices,
  createStoryServices,
  type StoryHost,
  type StoryServices,
  seedQueries,
} from '../support/host.js';

/**
 * One of the page's own elements, mounted as the shell mounts it: defined
 * under its tag, then handed the services. The element brings its own React
 * root, query client and toaster, so the story only binds the settings
 * adapter to a story host and seeds the window's shared client, fresh for
 * every mount.
 */
function PageElement({
  host = {},
  tag,
}: {
  readonly host?: StoryHost;
  readonly tag: 'settings-page' | 'settings-execution-picker';
}) {
  const [services] = useState<StoryServices>(() => {
    defineSettingsElements();
    if (customElements.get('settings-page') === undefined)
      customElements.define('settings-page', SettingsPageElement);
    if (customElements.get('settings-execution-picker') === undefined)
      customElements.define(
        'settings-execution-picker',
        ExecutionPickerElement,
      );
    clearSettingsQueryClient();
    seedQueries(settingsQueryClient(), host);
    return createStoryServices(host);
  });
  bindStoryServices(services);

  return createElement(tag, {
    ref: (element: HTMLElement | null) => {
      if (element !== null)
        (element as HTMLElement & { services: StoryServices }).services =
          services;
    },
  });
}

export default {
  title: 'Settings/Views/Settings page',
  decorators: [windowFrame],
};

export const SettingsPage = {
  render: () => <PageElement tag="settings-page" />,
};

export const SettingsPageExecution = {
  render: () => (
    <PageElement
      tag="settings-page"
      host={{ path: sectionPath('execution') }}
    />
  ),
};

export const ExecutionPicker = {
  decorators: [footerFrame],
  render: () => <PageElement tag="settings-execution-picker" />,
};
