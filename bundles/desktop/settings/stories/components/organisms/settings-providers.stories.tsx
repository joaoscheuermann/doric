import { useState } from 'react';

import { SettingsProviders } from '../../../src/client/components/organisms/settings-providers.js';
import type {
  Configuration,
  Credential,
  ProviderKind,
} from '../../../src/client/domain/config.js';
import {
  configuration,
  credentials,
  credentialsWithoutTokens,
  emptyConfiguration,
  providerKinds,
} from '../../support/fixtures.js';
import { sectionFrame } from '../../support/frames.js';
import { OpenOnMount, type OpenStep } from '../../support/open-on-mount.js';

/** The providers list over its own draft; a row's edit names its position. */
function Section({
  initial = configuration,
  kinds = providerKinds,
  open = [],
  stored = credentials,
}: {
  readonly initial?: Configuration;
  readonly kinds?: readonly ProviderKind[];
  readonly open?: readonly OpenStep[];
  readonly stored?: readonly Credential[];
}) {
  const [draft, setDraft] = useState(initial);
  const [opened, setOpened] = useState<string>();

  return (
    <OpenOnMount steps={open}>
      <SettingsProviders
        credentials={stored}
        draft={draft}
        kinds={kinds}
        onAdd={() => setOpened('Add provider')}
        onChange={setDraft}
        onEdit={(index) =>
          setOpened(`Edit ${draft.providers[index]?.id ?? index}`)
        }
      />
      {opened !== undefined && (
        <p className="mt-4 text-xs text-muted-foreground">
          The window would open: {opened}
        </p>
      )}
    </OpenOnMount>
  );
}

/** Enough providers that the table pages. */
const many: Configuration = {
  ...configuration,
  providers: [
    ...configuration.providers,
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `team-gateway-${index + 1}`,
      kind: 'openai',
      configuration: {
        endpoint: `https://gateway-${index + 1}.example.com/v1`,
      },
      models: [{ name: 'gpt-5-mini', reasonings: ['low', 'medium'] }],
    })),
  ],
};

export default {
  title: 'Settings/Organisms/Settings providers',
  component: SettingsProviders,
  decorators: [sectionFrame],
};

export const Default = {
  render: () => <Section />,
};

export const RowMenuOpen = {
  render: () => (
    <Section
      open={[
        {
          selector: '[aria-label="Actions for openrouter"]',
          gesture: 'pointerdown',
        },
      ]}
    />
  ),
};

export const Empty = {
  render: () => <Section initial={emptyConfiguration} />,
};

export const NoProviderKind = {
  render: () => <Section initial={emptyConfiguration} kinds={[]} />,
};

export const NoTokenStored = {
  render: () => <Section stored={credentialsWithoutTokens} />,
};

export const ManyProviders = {
  render: () => <Section initial={many} />,
};
