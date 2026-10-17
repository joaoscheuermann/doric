import { useState } from 'react';

import { SettingsProviderScreen } from '../../../src/client/components/organisms/settings-provider.js';
import {
  type Credential,
  emptyProviderDraft,
  type ProviderDraft,
  providerDraftOf,
} from '../../../src/client/domain/config.js';
import {
  codexKind,
  configuration,
  credentialIds,
  credentials,
  credentialsWithoutTokens,
  openRouterKind,
  providerKinds,
} from '../../support/fixtures.js';
import { sectionFrame } from '../../support/frames.js';
import { SettingsHost } from '../../support/host.js';
import { OpenOnMount, type OpenStep } from '../../support/open-on-mount.js';

const blank: ProviderDraft = { id: '', kind: '', configuration: {} };

/** The provider page over its own draft, as the providers section opens it. */
function Screen({
  initial,
  open = [],
  stored = credentials,
}: {
  readonly initial: ProviderDraft;
  readonly open?: readonly OpenStep[];
  readonly stored?: readonly Credential[];
}) {
  const [draft, setDraft] = useState(initial);

  return (
    <SettingsHost host={{ credentials: stored }}>
      {() => (
        <OpenOnMount steps={open}>
          <SettingsProviderScreen
            credentials={stored}
            draft={draft}
            kinds={providerKinds}
            onChange={setDraft}
          />
        </OpenOnMount>
      )}
    </SettingsHost>
  );
}

export default {
  title: 'Settings/Organisms/Settings provider',
  component: SettingsProviderScreen,
  decorators: [sectionFrame],
};

export const EditOpenRouter = {
  render: () => <Screen initial={providerDraftOf(configuration, 0) ?? blank} />,
};

export const ModelsTypedByHand = {
  render: () => <Screen initial={providerDraftOf(configuration, 1) ?? blank} />,
};

export const CatalogOpen = {
  render: () => (
    <Screen
      initial={providerDraftOf(configuration, 0) ?? blank}
      open={[{ selector: '[data-slot="collapsible-trigger"]' }]}
    />
  ),
};

export const AdvancedSettingsOpen = {
  render: () => (
    <Screen
      initial={providerDraftOf(configuration, 0) ?? blank}
      open={[
        {
          selector: '[data-slot="collapsible-trigger"]',
          text: 'Advanced settings',
        },
      ]}
    />
  ),
};

export const NewProvider = {
  render: () => <Screen initial={emptyProviderDraft(openRouterKind)} />,
};

export const KindWithoutModels = {
  render: () => (
    <Screen
      initial={{
        id: 'codex',
        kind: codexKind.id,
        configuration: {
          token: credentialIds.openAi,
          chatGptAccountId: 'acct_placeholder',
          fedramp: 'false',
        },
      }}
    />
  ),
};

export const NoTokenStored = {
  render: () => (
    <Screen
      initial={{ ...emptyProviderDraft(openRouterKind), id: 'openrouter' }}
      stored={credentialsWithoutTokens}
    />
  ),
};

export const NoKindChosen = {
  render: () => <Screen initial={blank} />,
};
