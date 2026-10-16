import { DiffToolbar } from '../../src/client/diff/diff-toolbar.js';
import { controls, tabDecorators } from '../support/diff.js';
import {
  addedDiff,
  binaryDiff,
  checkoutDiff,
  deletedDiff,
  tokensRepository,
  truncatedDiff,
  workspaceRepository,
} from '../support/fixtures.js';

const open = () => undefined;
const [, , pricing, , renamed, untracked] = workspaceRepository.changes;
const [conflicted] = tokensRepository.changes;

export default {
  title: 'Git/Diff/Diff toolbar',
  component: DiffToolbar,
  decorators: tabDecorators,
};

export const Modified = {
  render: () => (
    <DiffToolbar
      path={checkoutDiff.path}
      change={checkoutDiff}
      controls={controls()}
      canOpen
      onOpen={open}
    />
  ),
};

export const Added = {
  render: () => (
    <DiffToolbar
      path={addedDiff.path}
      change={addedDiff}
      controls={controls({ counts: { added: 11, removed: 0 } })}
      canOpen
      onOpen={open}
    />
  ),
};

/** A deleted file is struck through and cannot be opened. */
export const Deleted = {
  render: () => (
    <DiffToolbar
      path={deletedDiff.path}
      change={deletedDiff}
      controls={controls({ counts: { added: 0, removed: 3 } })}
      canOpen={false}
      onOpen={open}
    />
  ),
};

export const StagedAndUnstaged = {
  render: () => (
    <DiffToolbar
      path={pricing?.path ?? ''}
      change={pricing}
      controls={controls({ counts: { added: 31, removed: 12 } })}
      canOpen
      onOpen={open}
    />
  ),
};

export const Renamed = {
  render: () => (
    <DiffToolbar
      path={renamed?.path ?? ''}
      change={renamed}
      controls={controls({ counts: { added: 0, removed: 0 } })}
      canOpen
      onOpen={open}
    />
  ),
};

export const Untracked = {
  render: () => (
    <DiffToolbar
      path={untracked?.path ?? ''}
      change={untracked}
      controls={controls({ counts: { added: 64, removed: 0 } })}
      canOpen
      onOpen={open}
    />
  ),
};

export const Conflicted = {
  render: () => (
    <DiffToolbar
      path={`packages/design-tokens/${conflicted?.path ?? ''}`}
      change={conflicted}
      controls={controls({ counts: { added: 22, removed: 7 } })}
      canOpen
      onOpen={open}
    />
  ),
};

/** Only the beginning of each file was compared. */
export const Truncated = {
  render: () => (
    <DiffToolbar
      path={truncatedDiff.path}
      change={truncatedDiff}
      truncated
      controls={controls({ counts: { added: 2, removed: 1 } })}
      canOpen
      onOpen={open}
    />
  ),
};

export const Comparing = {
  render: () => (
    <DiffToolbar
      path={checkoutDiff.path}
      change={checkoutDiff}
      controls={controls({ counts: undefined })}
      canOpen
      onOpen={open}
    />
  ),
};

/** A binary file has no editor, so no controls. */
export const Binary = {
  render: () => (
    <DiffToolbar
      path={binaryDiff.path}
      change={binaryDiff}
      canOpen
      onOpen={open}
    />
  ),
};

/** Before the comparison arrives only the path is known. */
export const Reading = {
  render: () => (
    <DiffToolbar path={checkoutDiff.path} canOpen={false} onOpen={open} />
  ),
};
