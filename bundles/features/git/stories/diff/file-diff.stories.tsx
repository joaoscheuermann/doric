import type { GitApi } from '../../src/client/api/git-api.js';
import { FileDiffView } from '../../src/client/diff/file-diff.js';
import type { ProjectFileDiff } from '../../src/contracts/index.js';
import { fullTabDecorators } from '../support/diff.js';
import {
  addedDiff,
  binaryDiff,
  checkoutDiff,
  deletedDiff,
  project,
  truncatedDiff,
} from '../support/fixtures.js';
import {
  failing,
  fakeGitApi,
  GitHarness,
  never,
  windowServices,
} from '../support/git-harness.js';

const services = windowServices();

const answering = (diff: ProjectFileDiff): GitApi =>
  fakeGitApi({ fileDiff: async () => ({ status: 'ready', diff }) });

/** One comparison tab over `api`, for `diff`'s repository and path. */
function Tab({
  api,
  diff,
}: {
  readonly api: GitApi;
  readonly diff: Pick<ProjectFileDiff, 'repository' | 'path'>;
}) {
  return (
    <GitHarness api={api}>
      <FileDiffView
        services={services}
        projectId={project.id}
        repository={diff.repository}
        path={diff.path}
      />
    </GitHarness>
  );
}

export default {
  title: 'Git/Diff/File diff',
  component: FileDiffView,
  decorators: fullTabDecorators,
};

/** The Monaco diff editor over HEAD and the working tree. */
export const Modified = {
  render: () => <Tab api={answering(checkoutDiff)} diff={checkoutDiff} />,
};

export const Added = {
  render: () => <Tab api={answering(addedDiff)} diff={addedDiff} />,
};

export const Deleted = {
  render: () => <Tab api={answering(deletedDiff)} diff={deletedDiff} />,
};

export const Truncated = {
  render: () => <Tab api={answering(truncatedDiff)} diff={truncatedDiff} />,
};

export const Binary = {
  render: () => <Tab api={answering(binaryDiff)} diff={binaryDiff} />,
};

/** The file was committed, reverted or removed since the row was drawn. */
export const NoLongerChanged = {
  render: () => (
    <Tab
      api={fakeGitApi({ fileDiff: async () => ({ status: 'not_found' }) })}
      diff={checkoutDiff}
    />
  ),
};

export const LeaseExpired = {
  render: () => (
    <Tab
      api={fakeGitApi({ fileDiff: async () => ({ status: 'expired' }) })}
      diff={checkoutDiff}
    />
  ),
};

export const Loading = {
  render: () => (
    <Tab api={fakeGitApi({ fileDiff: never })} diff={checkoutDiff} />
  ),
};

/** A failed read draws the toolbar and footer; the toast says why. */
export const ReadFailed = {
  render: () => (
    <Tab
      api={fakeGitApi({
        fileDiff: () => failing('The comparison could not be read.'),
      })}
      diff={checkoutDiff}
    />
  ),
};

/** Without its Project, repository and path the tab draws nothing. */
export const MissingProps = {
  render: () => (
    <GitHarness api={fakeGitApi()}>
      <FileDiffView services={services} />
    </GitHarness>
  ),
};
