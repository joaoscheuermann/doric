import { useState } from 'react';

import { ProviderModelPicker } from '../../../src/client/components/organisms/provider-model-picker.js';
import type { ProviderDraft } from '../../../src/client/domain/config.js';
import {
  configuration,
  largeCatalog,
  openRouterKind,
} from '../../support/fixtures.js';
import { sectionFrame } from '../../support/frames.js';
import { pending, SettingsHost, type StoryHost } from '../../support/host.js';
import { OpenOnMount } from '../../support/open-on-mount.js';

const openRouter: ProviderDraft = {
  ...(configuration.providers[0] ?? {
    id: 'openrouter',
    kind: 'openrouter',
    configuration: {},
  }),
  index: 0,
};

/** The picker over its own draft, opened when `open` says so. */
function Picker({
  host,
  initial = openRouter,
  open = false,
}: {
  readonly host?: StoryHost;
  readonly initial?: ProviderDraft;
  readonly open?: boolean;
}) {
  const [draft, setDraft] = useState(initial);

  return (
    <SettingsHost host={host}>
      {() => (
        <OpenOnMount
          steps={
            open ? [{ selector: '[data-slot="collapsible-trigger"]' }] : []
          }
        >
          <ProviderModelPicker
            draft={draft}
            kind={openRouterKind}
            onChange={setDraft}
          />
        </OpenOnMount>
      )}
    </SettingsHost>
  );
}

export default {
  title: 'Settings/Organisms/Provider model picker',
  component: ProviderModelPicker,
  decorators: [sectionFrame],
};

export const Collapsed = {
  render: () => <Picker />,
};

export const Open = {
  render: () => <Picker open />,
};

export const NothingOffered = {
  render: () => <Picker open initial={{ ...openRouter, models: [] }} />,
};

export const LargeCatalog = {
  render: () => <Picker open host={{ catalog: largeCatalog }} />,
};

export const ReadingCatalog = {
  render: () => (
    <Picker
      open
      host={{ catalog: pending }}
      initial={{ ...openRouter, models: [] }}
    />
  ),
};

export const CatalogUnreadable = {
  render: () => (
    <Picker open host={{ catalog: new Error('The endpoint refused.') }} />
  ),
};
