// layout.workspace/v1 as another bundle reads it: the sidebar tree's
// records, the selected Thread once the tree describes it, and change
// notifications until the subscription is disposed.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Disposable, Services } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { RuntimeRecords } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';

import {
  emptyTree,
  type ProjectTree,
} from '../src/client/domain/project-tree.js';
import type { Project, Thread } from '../src/client/domain/workspace.js';
import { setWorkspaceServices } from '../src/client/services/workspace-services.js';
import { createLayoutWorkspace } from '../src/client/services/workspace-workspace.js';
import { bindRecords, workspaceStore } from '../src/client/stores/workspace.js';
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
afterEach(() => {
  bindRecords(undefined);
  setWorkspaceServices(undefined);
});

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

  test('subscribers hear nothing when a selection or a load changes nothing', async () => {
    const { workspace, dispose } = setup();
    setTree({
      threadsByProject: { p1: [thread('t1', 'p1')] },
      selection: { projectId: 'p1', threadId: 't1' },
    });
    workspaceStore.setState({ loadingProjectThreads: new Set() });
    let heard = 0;
    const subscription = workspace.subscribe(() => {
      heard += 1;
    });
    const store = workspaceStore.getState();

    store.select({ projectId: 'p1', threadId: 't1' });
    store.select({ projectId: 'p1' });
    store.endThreadsLoad('p1');
    const unchanged = heard;
    store.beginThreadsLoad('p1');
    store.beginThreadsLoad('p1');
    const started = heard;
    store.endThreadsLoad('p1');

    assert.equal(unchanged, 0);
    assert.equal(started, 1);
    assert.equal(heard, 2);
    assert.equal(workspace.selectedThread()?.id, 't1');
    subscription.dispose();
    await dispose();
  });
});

// Bundle isolation 4(c), T4.12: during the transition `workspace` provides
// `layout.workspace/v1` unchanged, answering what the records mirror and the
// selection hold (moved from `L/tests/workspace-additions.test.ts:91-159`).
const project = (id: string): Project =>
  ({
    id,
    name: id,
    state: 'ready',
    createdAt: '',
    updatedAt: '',
  }) as unknown as Project;

type Connection = ReturnType<RuntimeRecords['connection']>;

/**
 * Binds a records mirror whose connection the test sets: its `connection()`
 * answers the last status set, and setting one calls its subscribers.
 */
/**
 * Binds a records mirror whose connection the test sets: its `connection()`
 * answers the last status set, and setting one calls its subscribers.
 */
const connection = () => {
  let status: Connection = 'disconnected';
  const listeners = new Set<() => void>();
  const records = createRecordsApi({ connection: 'disconnected' });
  records.connection = () => status;
  records.subscribe = (listener): Disposable => {
    listeners.add(listener);
    return { dispose: () => void listeners.delete(listener) };
  };
  bindRecords(records);
  return (next: Connection) => {
    status = next;
    for (const listener of [...listeners]) listener();
  };
};

describe('layout.workspace/v1@1.1.0 from workspace (T4.12)', () => {
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

  // `:707`: the bottom split is the shell's; the transition id forwards the
  // request to `layout.conversation/v1` (step 4(c), plan 2.1).
  test('setBottomVisible forwards to layout.conversation/v1', async () => {
    const received: [string, boolean][] = [];
    setWorkspaceServices({
      use: (contract: { readonly id: string }) => {
        if (contract.id !== 'layout.conversation/v1') {
          throw new Error(`No "${contract.id}" in this test.`);
        }
        return {
          setBottomVisible: (itemId: string, visible: boolean) => {
            received.push([itemId, visible]);
          },
        };
      },
    } as unknown as Services);
    const { workspace, dispose } = setup();

    workspace.setBottomVisible('x', true);
    workspace.setBottomVisible('x', false);

    assert.deepEqual(received, [
      ['x', true],
      ['x', false],
    ]);
    await dispose();
  });
});
