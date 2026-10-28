import { type ComponentType, useState } from 'react';

import { SettingsCredentials } from '../../../src/client/components/organisms/settings-credentials.js';
import { SettingsExecution } from '../../../src/client/components/organisms/settings-execution.js';
import { SettingsProfile } from '../../../src/client/components/organisms/settings-profile.js';
import { SettingsProviderScreen } from '../../../src/client/components/organisms/settings-provider.js';
import { SettingsProviders } from '../../../src/client/components/organisms/settings-providers.js';
import { SettingsTools } from '../../../src/client/components/organisms/settings-tools.js';
import { SettingsWindow } from '../../../src/client/components/templates/settings-window.js';
import {
  type ProviderDraft,
  providerDraftOf,
  providerLabel,
} from '../../../src/client/domain/config.js';
import {
  configuration,
  credentials,
  providerKinds,
} from '../../support/fixtures.js';
import { windowFrame } from '../../support/frames.js';
import { SettingsHost } from '../../support/host.js';
import {
  NavSaveState,
  RevisionFooter,
  SectionHeading,
  type SectionId,
  useNav,
} from '../../support/window-parts.js';

/**
 * The settings window's frame around the real sections, each over the same
 * draft, as the view composes it: the providers section opens a provider page
 * one level deeper, which the bar's breadcrumb and back control lead out of.
 */
function Window({
  initial = 'providers',
  openProvider,
  query,
  saveState = 'Saved',
  saveFailed = false,
}: {
  readonly initial?: SectionId;
  readonly openProvider?: number;
  readonly query?: string;
  readonly saveState?: string;
  readonly saveFailed?: boolean;
}) {
  const nav = useNav(initial, query);
  const [draft, setDraft] = useState(configuration);
  const [provider, setProvider] = useState<ProviderDraft | undefined>(
    openProvider === undefined
      ? undefined
      : providerDraftOf(configuration, openProvider),
  );
  const page = nav.active === 'providers' ? provider : undefined;

  const section = (() => {
    switch (nav.active) {
      case 'profile':
        return <SettingsProfile draft={draft} onChange={setDraft} />;
      case 'providers':
        return (
          <SettingsProviders
            credentials={credentials}
            draft={draft}
            kinds={providerKinds}
            onAdd={() => {}}
            onChange={setDraft}
            onEdit={(index) => setProvider(providerDraftOf(draft, index))}
          />
        );
      case 'execution':
        return <SettingsExecution draft={draft} onChange={setDraft} />;
      case 'tools':
        return <SettingsTools draft={draft} onChange={setDraft} />;
      case 'credentials':
        return <SettingsCredentials />;
    }
  })();

  return (
    <SettingsWindow
      footer={<RevisionFooter destructive={saveFailed} text={saveState} />}
      nav={nav.nav}
      navEmpty={nav.empty}
      onBack={page === undefined ? undefined : () => setProvider(undefined)}
      onQueryChange={nav.setQuery}
      query={nav.query}
      sidebarFooter={<NavSaveState destructive={saveFailed} text={saveState} />}
      trail={[
        { label: 'Settings' },
        page === undefined
          ? { label: nav.current.label }
          : {
              label: nav.current.label,
              onSelect: () => setProvider(undefined),
            },
        ...(page === undefined
          ? []
          : [{ label: providerLabel(page, page.index ?? 0) }]),
      ]}
    >
      {page === undefined ? (
        <>
          <SectionHeading id={nav.active} />
          {section}
        </>
      ) : (
        <>
          <SectionHeading id="providers" title="Edit provider" />
          <SettingsProviderScreen
            credentials={credentials}
            draft={page}
            kinds={providerKinds}
            onChange={setProvider}
          />
        </>
      )}
    </SettingsWindow>
  );
}

export default {
  title: 'Settings/Templates/Settings window',
  component: SettingsWindow,
  decorators: [
    (Story: ComponentType) => <SettingsHost>{() => <Story />}</SettingsHost>,
    windowFrame,
  ],
};

export const Providers = {
  render: () => <Window />,
};

export const ProviderPage = {
  render: () => <Window openProvider={0} />,
};

export const Execution = {
  render: () => <Window initial="execution" saveState="Saving…" />,
};

export const Tools = {
  render: () => <Window initial="tools" />,
};

export const Credentials = {
  render: () => <Window initial="credentials" />,
};

export const Searching = {
  render: () => <Window initial="execution" query="turns" />,
};

export const SaveFailed = {
  render: () => (
    <Window
      initial="execution"
      saveFailed
      saveState="The Doric configuration could not be activated."
    />
  ),
};
