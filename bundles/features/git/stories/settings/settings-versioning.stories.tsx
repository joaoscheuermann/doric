import { useState } from 'react';

import type { VersioningDraft } from '../../src/client/api/peers.js';
import type { Credential } from '../../src/client/domain/credentials.js';
import { SettingsVersioning } from '../../src/client/settings/settings-versioning.js';
import { credentials } from '../support/fixtures.js';
import { settingsDecorators } from '../support/settings.js';

/** The section over a local draft, so the choices write as they would. */
function Section({
  initial,
  stored = credentials,
}: {
  readonly initial: VersioningDraft;
  readonly stored?: readonly Credential[];
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <SettingsVersioning
      credentials={stored}
      draft={draft}
      onChange={(update) => setDraft((current) => update(current))}
    />
  );
}

export default {
  title: 'Git/Settings/Settings versioning',
  component: SettingsVersioning,
  decorators: settingsDecorators,
};

export const Chosen = {
  render: () => (
    <Section
      initial={{
        gitCredentialId: 'cred-git-work',
        githubCredentialId: 'cred-github-bot',
      }}
    />
  ),
};

export const NothingChosen = {
  render: () => <Section initial={{}} />,
};

/** Only a Git identity is stored: GitHub has nothing to offer. */
export const NoToken = {
  render: () => (
    <Section
      initial={{ gitCredentialId: 'cred-git-work' }}
      stored={credentials.filter((credential) => credential.kind === 'GIT')}
    />
  ),
};

export const NoCredentials = {
  render: () => <Section initial={{}} stored={[]} />,
};

/** A choice whose credential was deleted shows no matching item. */
export const StaleChoice = {
  render: () => (
    <Section initial={{ githubCredentialId: 'cred-github-revoked' }} />
  ),
};
