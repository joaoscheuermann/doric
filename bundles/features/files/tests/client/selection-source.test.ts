// The one adapter the files client reads the window through (bundle isolation
// 4(d), plan 2.7): the selected ids of `workspace.selection/v1` and the
// records of `runtime.records/v1`, as the Project and Thread records the
// commands and the tree read, and as the `RefreshWorkspace` the refresh
// coordinator listens to. Observed through its answers, over a fake
// selection and the records fake of `runtime/testing`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Project, Thread } from 'runtime/contracts';
import { createRecordsApi, type RecordsFakeOptions } from 'runtime/testing';

import {
  refreshWorkspaceOf,
  selectionOf,
} from '../../src/client/api/selection.js';

const project: Project = {
  id: 'p-1',
  name: 'Storefront',
  state: 'ready',
  configRevision: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const threadOf = (id: string, cwd: string): Thread => ({
  id,
  projectId: project.id,
  name: id,
  state: 'ready',
  lastSequence: 0,
  cwd,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const selected = threadOf('t-1', '/workspace');
const other = threadOf('t-2', '/workspace/other');

/** `workspace.selection/v1` over ids the test changes, telling its listeners. */
const fakeSelection = (
  initial: { readonly projectId?: string; readonly threadId?: string } = {
    projectId: project.id,
    threadId: selected.id,
  },
) => {
  let ids = initial;
  const listeners = new Set<() => void>();
  return {
    current: () => ids,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    select(next: { readonly projectId?: string; readonly threadId?: string }) {
      ids = next;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
};

/** The records fake with the Project and its two Threads, described. */
const recordsWith = (options: RecordsFakeOptions = {}) => {
  const records = createRecordsApi({
    projects: [project],
    threads: [selected, other],
    ...options,
  });
  records.threads(project.id);
  return records;
};

describe('selectionOf', () => {
  test("answers the records of the selection's Project and Thread", () => {
    const selection = selectionOf(fakeSelection(), recordsWith());

    assert.equal(selection.project?.id, project.id);
    assert.equal(selection.project?.name, 'Storefront');
    assert.equal(selection.thread?.id, selected.id);
    assert.equal(selection.thread?.cwd, '/workspace');
  });

  test('answers neither while nothing is selected', () => {
    const selection = selectionOf(fakeSelection({}), recordsWith());

    assert.equal(selection.project, undefined);
    assert.equal(selection.thread, undefined);
  });
});

describe('refreshWorkspaceOf', () => {
  test("selection() answers the selected Project's id and state and the Thread's id and cwd", () => {
    const workspace = refreshWorkspaceOf(fakeSelection(), recordsWith());

    const { project: shown, thread } = workspace.selection();
    assert.equal(shown?.id, project.id);
    assert.equal(shown?.state, 'ready');
    assert.equal(thread?.id, selected.id);
    assert.equal(thread?.cwd, '/workspace');
  });

  test("threads() answers the records' Threads of the Project", () => {
    const workspace = refreshWorkspaceOf(fakeSelection(), recordsWith());

    assert.deepEqual(
      workspace
        .threads(project.id)
        .map(
          ({
            id,
            state,
            cwd,
          }: {
            readonly id: string;
            readonly state: string;
            readonly cwd?: string;
          }) => ({ id, state, cwd }),
        ),
      [
        { id: 't-1', state: 'ready', cwd: '/workspace' },
        { id: 't-2', state: 'ready', cwd: '/workspace/other' },
      ],
    );
  });

  for (const answer of ['pending', 'failing'] as const) {
    test(`threads() answers no Thread while the records' read is ${answer === 'pending' ? 'loading' : 'failed'}`, () => {
      const workspace = refreshWorkspaceOf(
        fakeSelection(),
        recordsWith({ [answer]: ['threads'] }),
      );

      assert.deepEqual(workspace.threads(project.id), []);
    });
  }

  test("connected() is whether the records' connection is connected", () => {
    assert.equal(
      refreshWorkspaceOf(fakeSelection(), recordsWith()).connected(),
      true,
    );
    assert.equal(
      refreshWorkspaceOf(
        fakeSelection(),
        recordsWith({ connection: 'disconnected' }),
      ).connected(),
      false,
    );
  });

  test('one listener hears a selection change and a records change, until disposed', async () => {
    const selection = fakeSelection();
    const records = recordsWith();
    const workspace = refreshWorkspaceOf(selection, records);
    let heard = 0;
    const subscription = workspace.subscribe(() => {
      heard += 1;
    });

    selection.select({ projectId: project.id, threadId: other.id });
    const afterSelection = heard;
    assert.ok(afterSelection >= 1, 'a selection change was not heard');
    assert.equal(workspace.selection().thread?.cwd, '/workspace/other');

    await records.renameThread({ threadId: other.id, name: 'Renamed' });
    assert.ok(heard > afterSelection, 'a records change was not heard');

    subscription.dispose();
    const afterDispose = heard;
    selection.select({ projectId: project.id, threadId: selected.id });
    await records.renameThread({ threadId: selected.id, name: 'Again' });
    assert.equal(heard, afterDispose, 'a disposed listener was called');
    assert.equal(selection.listeners(), 0);
  });
});
