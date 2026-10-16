import { useState } from 'react';

import { SettingsTools } from '../../../src/client/components/organisms/settings-tools.js';
import { configuration, toolCatalog } from '../../support/fixtures.js';
import { sectionFrame } from '../../support/frames.js';
import { pending, SettingsHost, type StoryHost } from '../../support/host.js';

/** The tools section over its own draft and a story host's tool catalog. */
function Section({ host }: { readonly host?: StoryHost }) {
  const [draft, setDraft] = useState(configuration);

  return (
    <SettingsHost host={host}>
      {() => <SettingsTools draft={draft} onChange={setDraft} />}
    </SettingsHost>
  );
}

export default {
  title: 'Settings/Organisms/Settings tools',
  component: SettingsTools,
  decorators: [sectionFrame],
};

export const Default = {
  render: () => <Section />,
};

export const Loading = {
  render: () => <Section host={{ tools: pending }} />,
};

export const CatalogUnreadable = {
  render: () => <Section host={{ tools: new Error('Unavailable') }} />,
};

export const NoConfigurableTools = {
  render: () => (
    <Section
      host={{
        tools: toolCatalog.map((tool) => ({ ...tool, settings: [] })),
      }}
    />
  ),
};
