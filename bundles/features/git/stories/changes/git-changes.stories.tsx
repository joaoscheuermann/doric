import { GitChangesView } from '../../src/client/changes/git-changes.js';
import {
  cleanChanges,
  manyChanges,
  multiRepositoryChanges,
  nestedThread,
  noRepositories,
  tokensRepository,
} from '../support/fixtures.js';
import {
  failing,
  fakeGitApi,
  GitHarness,
  never,
  readyTree,
  windowServices,
} from '../support/git-harness.js';
import { panelDecorators } from '../support/panel.js';

const workspace = windowServices({ tree: readyTree });

export default {
  title: 'Git/Changes/Git changes',
  component: GitChangesView,
  decorators: panelDecorators,
};

export const Changes = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <GitChangesView services={workspace} />
    </GitHarness>
  ),
};

const comparing = windowServices({
  tree: readyTree,
  comparing: { repository: '', path: 'src/lib/pricing.ts' },
});

export const ComparisonOpen = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <GitChangesView services={comparing} />
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
      <GitChangesView services={workspace} />
    </GitHarness>
  ),
};

export const ManyFiles = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        changes: async () => ({ status: 'ready', changes: manyChanges }),
      })}
    >
      <GitChangesView services={workspace} />
    </GitHarness>
  ),
};

const nested = windowServices({ tree: readyTree, thread: nestedThread });

export const NestedWorkingDirectory = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        changes: async () => ({
          status: 'ready',
          changes: {
            path: 'packages/design-tokens/src/themes/high-contrast',
            repositories: [tokensRepository],
          },
        }),
      })}
    >
      <GitChangesView services={nested} />
    </GitHarness>
  ),
};

export const NoChanges = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        changes: async () => ({ status: 'ready', changes: cleanChanges }),
      })}
    >
      <GitChangesView services={workspace} />
    </GitHarness>
  ),
};

export const NoRepositories = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        changes: async () => ({ status: 'ready', changes: noRepositories }),
      })}
    >
      <GitChangesView services={workspace} />
    </GitHarness>
  ),
};

export const Loading = {
  render: () => (
    <GitHarness api={fakeGitApi({ changes: never })}>
      <GitChangesView services={workspace} />
    </GitHarness>
  ),
};

/** The lease ended: the changes cannot be read, the tree still could. */
export const LeaseExpired = {
  render: () => (
    <GitHarness
      api={fakeGitApi({ changes: async () => ({ status: 'expired' }) })}
    >
      <GitChangesView services={workspace} />
    </GitHarness>
  ),
};

const unavailableSandbox = windowServices({
  tree: { read: { status: 'unavailable' }, fetching: false },
});

/** The files tree read says the sandbox itself cannot be read. */
export const SandboxUnavailable = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <GitChangesView services={unavailableSandbox} />
    </GitHarness>
  ),
};

const treeLoading = windowServices({
  tree: { read: { status: 'loading' }, fetching: true },
});

export const SandboxLoading = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <GitChangesView services={treeLoading} />
    </GitHarness>
  ),
};

const withoutFiles = windowServices();

/** Without the files bundle there is no tree read to wait for. */
export const WithoutFilesBundle = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <GitChangesView services={withoutFiles} />
    </GitHarness>
  ),
};

/**
 * A failed read with no earlier answer draws nothing in the panel; its
 * message goes to the window's toaster, which the layout mounts.
 */
export const ReadFailed = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        changes: () => failing('The changes could not be read.'),
      })}
    >
      <GitChangesView services={workspace} />
    </GitHarness>
  ),
};

const noProject = windowServices({
  tree: readyTree,
  project: undefined,
  thread: undefined,
});

export const NoProjectSelected = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <GitChangesView services={noProject} />
    </GitHarness>
  ),
};
