import { WorkspaceCwdView } from '../../src/client/cwd/workspace-cwd-view.js';
import { onBranch, project } from '../support/fixtures.js';
import { footerDecorators } from '../support/footer.js';
import {
  fakeGitApi,
  GitHarness,
  windowServices,
} from '../support/git-harness.js';

const selected = windowServices();
const projectOnly = windowServices({ project, thread: undefined });

export default {
  title: 'Git/Cwd/Workspace cwd view',
  component: WorkspaceCwdView,
  decorators: footerDecorators,
};

export const SelectedThread = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <WorkspaceCwdView services={selected} />
    </GitHarness>
  ),
};

/** A Project with no Thread selected: the footer has no directory to show. */
export const NoThreadSelected = {
  render: () => (
    <GitHarness api={fakeGitApi({ git: async () => onBranch })}>
      <WorkspaceCwdView services={projectOnly} />
    </GitHarness>
  ),
};
