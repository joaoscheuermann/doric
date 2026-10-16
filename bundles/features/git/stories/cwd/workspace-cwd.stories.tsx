import { WorkspaceCwd } from '../../src/client/cwd/workspace-cwd.js';
import type { ChangesObservation } from '../../src/contracts/index.js';
import {
  changes,
  cleanBranch,
  cleanChanges,
  detached,
  environmentUnavailable,
  nestedThread,
  notRepository,
  onBranch,
  rebasing,
  runningThread,
  thread,
  tokensRepository,
} from '../support/fixtures.js';
import { footerDecorators, OpenOnMount } from '../support/footer.js';
import { failing, fakeGitApi, GitHarness } from '../support/git-harness.js';

type Read = ChangesObservation['read'];

const ready: Read = { status: 'ready', value: changes };
const clean: Read = { status: 'ready', value: cleanChanges };
const nestedRead: Read = {
  status: 'ready',
  value: { repositories: [tokensRepository] },
};
const show = () => undefined;

export default {
  title: 'Git/Cwd/Workspace cwd',
  component: WorkspaceCwd,
  decorators: footerDecorators,
};

export const OnBranch = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <WorkspaceCwd thread={thread} changes={ready} onShowChanges={show} />
    </GitHarness>
  ),
};

export const CleanMain = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => cleanBranch })}>
      <WorkspaceCwd thread={thread} changes={clean} onShowChanges={show} />
    </GitHarness>
  ),
};

export const DetachedHead = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => detached })}>
      <WorkspaceCwd thread={thread} changes={ready} onShowChanges={show} />
    </GitHarness>
  ),
};

/** A linked worktree, deep inside the repository, stopped mid-rebase. */
export const RebaseConflictInWorktree = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => rebasing })}>
      <WorkspaceCwd
        thread={nestedThread}
        changes={nestedRead}
        onShowChanges={show}
      />
    </GitHarness>
  ),
};

/** The totals show "…" until the changes are read. */
export const ChangesReading = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <WorkspaceCwd
        thread={thread}
        changes={{ status: 'loading' }}
        onShowChanges={show}
      />
    </GitHarness>
  ),
};

export const NotARepository = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => notRepository })}>
      <WorkspaceCwd
        thread={thread}
        changes={{ status: 'ready', value: { repositories: [] } }}
        onShowChanges={show}
      />
    </GitHarness>
  ),
};

export const EnvironmentUnavailable = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => environmentUnavailable })}>
      <WorkspaceCwd
        thread={thread}
        changes={{ status: 'unavailable' }}
        onShowChanges={show}
      />
    </GitHarness>
  ),
};

/** The summary could not be read: the path still shows; the toast says why. */
export const SummaryFailed = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        git: () => failing('The git summary could not be read.'),
      })}
    >
      <WorkspaceCwd thread={thread} changes={ready} onShowChanges={show} />
    </GitHarness>
  ),
};

const details = ['Working directory and branch'];

export const DetailsOpen = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <OpenOnMount labels={details}>
        <WorkspaceCwd thread={thread} changes={ready} onShowChanges={show} />
      </OpenOnMount>
    </GitHarness>
  ),
};

const branchPicker = ['Working directory and branch', 'Select branch'];

export const BranchPickerOpen = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <OpenOnMount labels={branchPicker}>
        <WorkspaceCwd thread={thread} changes={ready} onShowChanges={show} />
      </OpenOnMount>
    </GitHarness>
  ),
};

/** A running Thread cannot open the branch picker. */
export const ThreadRunningDetailsOpen = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <OpenOnMount labels={details}>
        <WorkspaceCwd
          thread={runningThread}
          changes={ready}
          onShowChanges={show}
        />
      </OpenOnMount>
    </GitHarness>
  ),
};

/** Without a Thread the footer draws nothing. */
export const NoThread = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <WorkspaceCwd changes={{ status: 'idle' }} onShowChanges={show} />
    </GitHarness>
  ),
};
