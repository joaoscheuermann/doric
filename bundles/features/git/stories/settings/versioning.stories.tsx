import { VersioningView } from '../../src/client/settings/versioning.js';
import { credentials } from '../support/fixtures.js';
import {
  fakeGitApi,
  GitHarness,
  windowServices,
} from '../support/git-harness.js';
import { settingsDecorators } from '../support/settings.js';

const chosen = windowServices({
  settings: {
    draft: { gitCredentialId: 'cred-git-work' },
    credentials,
  },
});

const empty = windowServices({ settings: { draft: {}, credentials: [] } });

/** Without the settings window's draft the section draws nothing. */
const outsideSettings = windowServices();

export default {
  title: 'Git/Settings/Versioning',
  component: VersioningView,
  decorators: settingsDecorators,
};

export const StoredCredentials = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <VersioningView services={chosen} />
    </GitHarness>
  ),
};

export const NoStoredCredentials = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <VersioningView services={empty} />
    </GitHarness>
  ),
};

export const OutsideSettingsWindow = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <VersioningView services={outsideSettings} />
    </GitHarness>
  ),
};
