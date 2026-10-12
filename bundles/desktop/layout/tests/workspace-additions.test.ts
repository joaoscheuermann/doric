// layout.workspace/v1@1.1.0 (R-9.1, R-9.5): the validated selection the
// workspace shows, a Project's loaded Threads, the connection the sidebar
// footer states, and the bottom split's visibility requests.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Disposable } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import type { ConnectionStatus } from '../src/client/domain/connection.js';
import {
  emptyTree,
  type ProjectTree,
} from '../src/client/domain/project-tree.js';
import type { Project, Thread } from '../src/client/domain/workspace.js';
import { createLayoutWorkspace } from '../src/client/services/layout-workspace.js';
import { bottomStore, resetBottom } from '../src/client/stores/bottom.js';
import {
  disposeConnection,
  initConnection,
} from '../src/client/stores/connection.js';
import { workspaceStore } from '../src/client/stores/workspace.js';
import { LayoutWorkspaceV1 } from '../src/contracts/index.js';

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

const connection = () => {
  let status: ConnectionStatus = 'disconnected';
  const listeners = new Set<(status: ConnectionStatus) => void>();
  initConnection({
    status: () => status,
    subscribe: (listener): Disposable => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  });
  return (next: ConnectionStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
  };
};

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: [createLayoutWorkspace()],
  });
  return {
    workspace: harness.services.use(LayoutWorkspaceV1),
    dispose: harness.dispose,
  };
};

beforeEach(() => {
  setTree({});
  resetBottom();
});
afterEach(disposeConnection);

describe('layout.workspace/v1@1.1.0', () => {
  test('a Project-only selection names the Project and no Thread', async () => {
    const { workspace, dispose } = setup();
    setTree({
      projects: [project('p1')],
      threadsByProject: { p1: [thread('t1', 'p1')] },
      selection: { projectId: 'p1' },
    });

    const selection = workspace.selection();
    assert.equal(selection.project?.id, 'p1');
    assert.equal(selection.thread, undefined);
    await dispose();
  });

  test('a selected Thread joins the selection once the tree describes it', async () => {
    const { workspace, dispose } = setup();
    setTree({
      projects: [project('p1')],
      selection: { projectId: 'p1', threadId: 't1' },
    });
    assert.equal(workspace.selection().thread, undefined);

    setTree({
      projects: [project('p1')],
      threadsByProject: { p1: [thread('t1', 'p1')] },
      selection: { projectId: 'p1', threadId: 't1' },
    });
    assert.equal(workspace.selection().thread?.id, 't1');
    await dispose();
  });

  test('nothing selected is an empty selection', async () => {
    const { workspace, dispose } = setup();
    assert.deepEqual(workspace.selection(), {});
    await dispose();
  });

  test("threads lists a Project's loaded Threads, empty until described", async () => {
    const { workspace, dispose } = setup();
    setTree({
      threadsByProject: { p1: [thread('t1', 'p1'), thread('t2', 'p1')] },
    });

    assert.deepEqual(
      workspace.threads('p1').map((item) => item.id),
      ['t1', 't2'],
    );
    assert.deepEqual(workspace.threads('p2'), []);
    await dispose();
  });

  test('connected follows the connection and notifies subscribers', async () => {
    const { workspace, dispose } = setup();
    const setStatus = connection();
    let heard = 0;
    const subscription = workspace.subscribe(() => {
      heard += 1;
    });

    assert.equal(workspace.connected(), false);
    setStatus('connected');

    assert.equal(workspace.connected(), true);
    assert.ok(heard > 0);
    subscription.dispose();
    await dispose();
  });

  test('the bottom split shows while any item asks for it', async () => {
    const { workspace, dispose } = setup();
    const shown = () => bottomStore.getState().visible.size > 0;

    workspace.setBottomVisible('terminal-manual', true);
    workspace.setBottomVisible('other', true);
    workspace.setBottomVisible('terminal-manual', false);
    assert.equal(shown(), true);

    workspace.setBottomVisible('other', false);
    assert.equal(shown(), false);
    await dispose();
  });
});
