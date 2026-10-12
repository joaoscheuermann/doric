// layout.workspace/v1 as another bundle reads it: the sidebar tree's
// records, the selected Thread once the tree describes it, and change
// notifications until the subscription is disposed.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  emptyTree,
  type ProjectTree,
} from '../src/client/domain/project-tree.js';
import type { Thread } from '../src/client/domain/workspace.js';
import { createLayoutWorkspace } from '../src/client/services/layout-workspace.js';
import { workspaceStore } from '../src/client/stores/workspace.js';
import { LayoutWorkspaceV1 } from '../src/contracts/index.js';

const thread = (id: string, projectId: string): Thread => ({
  id,
  projectId,
  name: id,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});

const setTree = (tree: Partial<ProjectTree>) =>
  workspaceStore.setState({ tree: { ...emptyTree, ...tree } });

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'chat' },
    provide: [createLayoutWorkspace()],
  });
  return {
    workspace: harness.services.use(LayoutWorkspaceV1),
    dispose: harness.dispose,
  };
};

beforeEach(() => setTree({}));

describe('layout.workspace/v1', () => {
  test('finds a Thread of any described Project', async () => {
    const { workspace, dispose } = setup();
    setTree({
      threadsByProject: {
        p1: [thread('t1', 'p1')],
        p2: [thread('t2', 'p2')],
      },
    });

    assert.equal(workspace.thread('t2')?.projectId, 'p2');
    assert.equal(workspace.thread('missing'), undefined);
    await dispose();
  });

  test('the selected Thread is known once the tree describes it', async () => {
    const { workspace, dispose } = setup();
    setTree({ selection: { projectId: 'p1', threadId: 't1' } });
    assert.equal(workspace.selectedThread(), undefined);

    setTree({
      threadsByProject: { p1: [thread('t1', 'p1')] },
      selection: { projectId: 'p1', threadId: 't1' },
    });
    assert.equal(workspace.selectedThread()?.id, 't1');
    await dispose();
  });

  test('a Project-only selection has no selected Thread', async () => {
    const { workspace, dispose } = setup();
    setTree({
      threadsByProject: { p1: [thread('t1', 'p1')] },
      selection: { projectId: 'p1' },
    });

    assert.equal(workspace.selectedThread(), undefined);
    await dispose();
  });

  test('subscribers hear tree changes until they dispose', async () => {
    const { workspace, dispose } = setup();
    let heard = 0;
    const subscription = workspace.subscribe(() => {
      heard += 1;
    });

    setTree({ threadsByProject: { p1: [] } });
    const afterChange = heard;
    subscription.dispose();
    setTree({ threadsByProject: { p2: [] } });

    assert.ok(afterChange > 0);
    assert.equal(heard, afterChange);
    await dispose();
  });
});
