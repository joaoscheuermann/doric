import type { ComponentType } from 'react';

import { ChangesBadge } from '../../src/client/changes/changes-badge.js';
import { cleanChanges, multiRepositoryChanges } from '../support/fixtures.js';
import {
  fakeGitApi,
  GitHarness,
  never,
  windowServices,
} from '../support/git-harness.js';

const services = windowServices();

/** The badge sits in the panel's "Project views" strip, beside its label. */
const decorators = [
  (Story: ComponentType) => (
    <div className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
      <span>Changes</span>
      <Story />
    </div>
  ),
];

export default {
  title: 'Git/Changes/Changes badge',
  component: ChangesBadge,
  decorators,
};

export const WithChanges = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <ChangesBadge services={services} />
    </GitHarness>
  ),
};

export const SeveralRepositories = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        changes: async () => ({
          status: 'ready',
          changes: multiRepositoryChanges,
        }),
      })}
    >
      <ChangesBadge services={services} />
    </GitHarness>
  ),
};

/** A clean working tree draws no badge. */
export const CleanWorkingTree = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        changes: async () => ({ status: 'ready', changes: cleanChanges }),
      })}
    >
      <ChangesBadge services={services} />
    </GitHarness>
  ),
};

/** Nothing is drawn until the changes are read. */
export const Reading = {
  render: () => (
    <GitHarness api={fakeGitApi({ changes: never })}>
      <ChangesBadge services={services} />
    </GitHarness>
  ),
};
