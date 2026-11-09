import { WorkspaceCwd } from '../../src/client/cwd/workspace-cwd.js';
import {
  cleanBranch,
  detached,
  environmentUnavailable,
  nestedThread,
  notRepository,
  onBranch,
  rebasing,
  runningThread,
  thread,
} from '../support/fixtures.js';
import { footerDecorators, OpenOnMount } from '../support/footer.js';
import { failing, fakeGitApi, GitHarness } from '../support/git-harness.js';

export default {
  title: 'Git/Cwd/Workspace cwd',
  component: WorkspaceCwd,
  decorators: footerDecorators,
};

export const OnBranch = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <WorkspaceCwd thread={thread} />
    </GitHarness>
  ),
};

export const CleanMain = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => cleanBranch })}>
      <WorkspaceCwd thread={thread} />
    </GitHarness>
  ),
};

export const DetachedHead = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => detached })}>
      <WorkspaceCwd thread={thread} />
    </GitHarness>
  ),
};

/** A linked worktree, deep inside the repository, stopped mid-rebase. */
export const RebaseConflictInWorktree = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => rebasing })}>
      <WorkspaceCwd thread={nestedThread} />
    </GitHarness>
  ),
};

export const NotARepository = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => notRepository })}>
      <WorkspaceCwd thread={thread} />
    </GitHarness>
  ),
};

export const EnvironmentUnavailable = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => environmentUnavailable })}>
      <WorkspaceCwd thread={thread} />
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
      <WorkspaceCwd thread={thread} />
    </GitHarness>
  ),
};

const details = ['Working directory and branch'];

export const DetailsOpen = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <OpenOnMount labels={details}>
        <WorkspaceCwd thread={thread} />
      </OpenOnMount>
    </GitHarness>
  ),
};

const branchPicker = ['Working directory and branch', 'Select branch'];

export const BranchPickerOpen = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <OpenOnMount labels={branchPicker}>
        <WorkspaceCwd thread={thread} />
      </OpenOnMount>
    </GitHarness>
  ),
};

/** A running Thread cannot open the branch picker. */
export const ThreadRunningDetailsOpen = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <OpenOnMount labels={details}>
        <WorkspaceCwd thread={runningThread} />
      </OpenOnMount>
    </GitHarness>
  ),
};

/** Without a Thread the footer draws nothing. */
export const NoThread = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <WorkspaceCwd />
    </GitHarness>
  ),
};
