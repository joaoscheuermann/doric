import { sectionPath } from '../../src/client/domain/section-route.js';
import { Settings } from '../../src/client/views/settings-view.js';
import { defineSettingsElements } from '../support/core.js';
import {
  emptyConfiguration,
  storedConfiguration,
} from '../support/fixtures.js';
import { windowFrame } from '../support/frames.js';
import { pending, SettingsHost, type StoryHost } from '../support/host.js';
import { OpenOnMount, type OpenStep } from '../support/open-on-mount.js';

/**
 * The settings window's view over a story host: the host answers the
 * configuration, the provider kinds, the tools and the credentials from the
 * fixtures and stores every save, and the core stand-ins place the nav links
 * and the section the route shows, as the core does in the app.
 */
function View({
  host,
  open = [],
}: {
  readonly host?: StoryHost;
  readonly open?: readonly OpenStep[];
}) {
  defineSettingsElements();

  return (
    <SettingsHost host={host}>
      {(services) => (
        <OpenOnMount steps={open}>
          <Settings services={services} />
        </OpenOnMount>
      )}
    </SettingsHost>
  );
}

export default {
  title: 'Settings/Views/Settings view',
  component: Settings,
  decorators: [windowFrame],
};

export const Providers = {
  render: () => <View />,
};

export const ProviderPage = {
  render: () => (
    <View
      open={[
        {
          selector: '[aria-label="Actions for openrouter"]',
          gesture: 'pointerdown',
        },
        { selector: '[role="menuitem"]', text: 'Edit' },
      ]}
    />
  ),
};

export const AddProviderPage = {
  render: () => <View open={[{ selector: '[aria-label="Add provider"]' }]} />,
};

export const Execution = {
  render: () => <View host={{ path: sectionPath('execution') }} />,
};

export const Tools = {
  render: () => <View host={{ path: sectionPath('tools') }} />,
};

export const Credentials = {
  render: () => <View host={{ path: sectionPath('credentials') }} />,
};

export const Loading = {
  render: () => <View host={{ config: pending }} />,
};

export const NoProviderYet = {
  render: () => (
    <View host={{ config: storedConfiguration(emptyConfiguration) }} />
  ),
};

export const SaveRefused = {
  render: () => (
    <View
      host={{
        path: sectionPath('execution'),
        refuseSave: 'The Doric configuration could not be activated.',
      }}
      open={[
        {
          selector: 'button[aria-label="Reasoning effort"]',
          gesture: 'pointerdown',
        },
        { selector: '[role="menuitemradio"]', text: 'High' },
      ]}
    />
  ),
};
