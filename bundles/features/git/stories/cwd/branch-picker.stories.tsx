import type { ComponentType } from 'react';

import { BranchPicker } from '../../src/client/cwd/branch-picker.js';
import {
  blockedBranches,
  branchesUnavailable,
  noBranches,
  runningThread,
  thread,
} from '../support/fixtures.js';
import {
  failing,
  fakeGitApi,
  GitHarness,
  never,
} from '../support/git-harness.js';

/** The picker opens beside the footer's popover, in a popover of its own. */
const decorators = [
  (Story: ComponentType) => (
    <div className="w-80 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
      <Story />
    </div>
  ),
];

export default {
  title: 'Git/Cwd/Branch picker',
  component: BranchPicker,
  decorators,
};

const close = () => undefined;

export const Branches = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <BranchPicker thread={thread} onSelect={close} />
    </GitHarness>
  ),
};

/** A running Thread cannot switch branches. */
export const ThreadRunning = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <BranchPicker thread={runningThread} onSelect={close} />
    </GitHarness>
  ),
};

/** The host says why switching is blocked; every branch is disabled. */
export const SwitchBlocked = {
  render: () => (
    <GitHarness api={fakeGitApi({ branches: async () => blockedBranches })}>
      <BranchPicker thread={thread} onSelect={close} />
    </GitHarness>
  ),
};

export const EnvironmentUnavailable = {
  render: () => (
    <GitHarness api={fakeGitApi({ branches: async () => branchesUnavailable })}>
      <BranchPicker thread={thread} onSelect={close} />
    </GitHarness>
  ),
};

export const Loading = {
  render: () => (
    <GitHarness api={fakeGitApi({ branches: never })}>
      <BranchPicker thread={thread} onSelect={close} />
    </GitHarness>
  ),
};

export const NoLocalBranches = {
  render: () => (
    <GitHarness api={fakeGitApi({ branches: async () => noBranches })}>
      <BranchPicker thread={thread} onSelect={close} />
    </GitHarness>
  ),
};

/** Choosing a branch shows its spinner while the switch never answers. */
export const Switching = {
  render: () => (
    <GitHarness api={fakeGitApi({ switchBranch: never })}>
      <BranchPicker thread={thread} onSelect={close} />
    </GitHarness>
  ),
};

/** A refused switch is toasted by the window's toaster, which the layout mounts. */
export const SwitchRefused = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        switchBranch: () =>
          failing(
            'Your local changes to src/lib/pricing.ts would be overwritten by checkout.',
          ),
      })}
    >
      <BranchPicker thread={thread} onSelect={close} />
    </GitHarness>
  ),
};

export const ReadFailed = {
  render: () => (
    <GitHarness
      api={fakeGitApi({
        branches: () => failing('The branches could not be read.'),
      })}
    >
      <BranchPicker thread={thread} onSelect={close} />
    </GitHarness>
  ),
};
