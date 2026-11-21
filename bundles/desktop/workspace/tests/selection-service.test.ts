// workspace.selection/v1 (bundle isolation 4(c), T4.9): the validated
// selection as ids. `current()` answers the ids of the selection the records
// mirror describes and the same object until either id changes; `subscribe`
// hears a change of either id, and only such a change.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  emptyTree,
  type ProjectTree,
} from '../src/client/domain/project-tree.js';
import type { Project, Thread } from '../src/client/domain/workspace.js';
import { createWorkspaceSelection } from '../src/client/services/workspace-selection.js';
import { workspaceStore } from '../src/client/stores/workspace.js';
import { WorkspaceSelectionV1 } from '../src/contracts/index.js';

const project = (id: string): Project =>
  ({
    id,
    name: id,
    state: 'ready',
    createdAt: '',
    updatedAt: '',
  }) as unknown as Project;

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

/** `p1` described with `t1` and `t2`. */
const described = (selection: ProjectTree['selection']) =>
  setTree({
    projects: [project('p1'), project('p2')],
    threadsByProject: { p1: [thread('t1', 'p1'), thread('t2', 'p1')] },
    selection,
  });

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'chat' },
    provide: [createWorkspaceSelection()],
  });
  return {
    selection: harness.services.use(WorkspaceSelectionV1),
    dispose: harness.dispose,
  };
};

beforeEach(() => setTree({}));

describe('workspace.selection/v1', () => {
  test('answers the ids of a described selection, the same object while nothing changes', async () => {
    const { selection, dispose } = setup();
    described({ projectId: 'p1', threadId: 't1' });

    const first = selection.current();
    assert.deepEqual(first, { projectId: 'p1', threadId: 't1' });
    assert.equal(selection.current(), first);
    await dispose();
  });

  test('a selected Thread the mirror does not describe gives the Project only', async () => {
    const { selection, dispose } = setup();
    described({ projectId: 'p1', threadId: 't9' });

    assert.deepEqual(selection.current(), { projectId: 'p1' });
    await dispose();
  });

  test('nothing selected is an empty selection', async () => {
    const { selection, dispose } = setup();

    assert.deepEqual(selection.current(), {});
    await dispose();
  });

  test('a change of the Thread notifies once and answers the new ids', async () => {
    const { selection, dispose } = setup();
    described({ projectId: 'p1', threadId: 't1' });
    selection.current();
    let heard = 0;
    const subscription = selection.subscribe(() => {
      heard += 1;
    });

    workspaceStore.getState().select({ projectId: 'p1', threadId: 't2' });

    assert.equal(heard, 1);
    assert.deepEqual(selection.current(), { projectId: 'p1', threadId: 't2' });
    subscription.dispose();
    await dispose();
  });

  test('a change of the Project notifies', async () => {
    const { selection, dispose } = setup();
    described({ projectId: 'p1', threadId: 't1' });
    let heard = 0;
    const subscription = selection.subscribe(() => {
      heard += 1;
    });

    workspaceStore.getState().select({ projectId: 'p2' });

    assert.equal(heard, 1);
    assert.deepEqual(selection.current(), { projectId: 'p2' });
    subscription.dispose();
    await dispose();
  });

  test('a change of the records that leaves both ids as they are notifies nothing and keeps the object', async () => {
    const { selection, dispose } = setup();
    described({ projectId: 'p1', threadId: 't1' });
    const before = selection.current();
    let heard = 0;
    const subscription = selection.subscribe(() => {
      heard += 1;
    });

    workspaceStore.setState(({ tree }) => ({
      tree: {
        ...tree,
        threadsByProject: {
          ...tree.threadsByProject,
          p2: [thread('t3', 'p2')],
        },
      },
    }));

    assert.equal(heard, 0);
    assert.equal(selection.current(), before);
    subscription.dispose();
    await dispose();
  });

  test('a disposed subscription hears nothing', async () => {
    const { selection, dispose } = setup();
    described({ projectId: 'p1', threadId: 't1' });
    let heard = 0;
    selection
      .subscribe(() => {
        heard += 1;
      })
      .dispose();

    workspaceStore.getState().select({ projectId: 'p1', threadId: 't2' });

    assert.equal(heard, 0);
    await dispose();
  });
});
