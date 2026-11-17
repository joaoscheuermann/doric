import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type ErrorInfo, errorFrom } from 'desktop/reads';

import {
  beginDelete,
  beginProject,
  beginThread,
  cancelDraft,
  cancelRename,
  clearDeleting,
  clearError,
  clearProjectDraft,
  clearRename,
  clearThreadDraft,
  dismissDelete,
  emptySidebar,
  fail,
  report,
  requestDelete,
  type Sidebar,
  selectProject,
  selectThread,
  settle,
  settleDelete,
  startRename,
  threadRowPadding,
} from '../src/client/domain/sidebar.js';
import type {
  Draft,
  Entity,
  Project,
  Thread,
} from '../src/client/domain/workspace.js';

const project: Project = {
  id: 'project',
  name: 'project',
  state: 'ready',
  configRevision: 0,
  createdAt: '',
  updatedAt: '',
};

const thread: Thread = {
  id: 'thread',
  projectId: 'project',
  name: 'thread',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace/doric',
  createdAt: '',
  updatedAt: '',
};

const renamingProject: Entity = { kind: 'project', value: project };
const renamingThread: Entity = { kind: 'thread', value: thread };

/** A sidebar with a draft, a rename, a delete dialog and an error open. */
const busy: Sidebar = {
  draft: { kind: 'project' },
  editing: renamingThread,
  deleting: renamingProject,
  deletingPending: false,
  error: { error: errorFrom('internal', 'Something failed.') },
};

describe('the dialogs a sidebar step opens', () => {
  test('opening a draft replaces the rename and drops the shown error', () => {
    const projectDraft = beginProject(busy);
    assert.deepEqual(projectDraft.draft, { kind: 'project' });
    assert.equal(projectDraft.editing, undefined);
    assert.equal(projectDraft.error, undefined);

    const threadDraft = beginThread(busy, 'project', 'parent');
    assert.deepEqual(threadDraft.draft, {
      kind: 'thread',
      projectId: 'project',
      parentThreadId: 'parent',
    });
    assert.equal(threadDraft.editing, undefined);
    assert.equal(threadDraft.error, undefined);
  });

  test('selecting a Project starts the sidebar over', () => {
    const next = selectProject(busy);
    assert.equal(next.draft, undefined);
    assert.equal(next.editing, undefined);
    assert.equal(next.error, undefined);
  });

  test('selecting a Thread drops the dialogs but keeps the error', () => {
    const next = selectThread(busy);
    assert.equal(next.draft, undefined);
    assert.equal(next.editing, undefined);
    assert.equal(next.error, busy.error);
  });

  test('starting a rename replaces the draft beside it', () => {
    const next = startRename(busy, renamingProject);
    assert.deepEqual(next.editing, renamingProject);
    assert.equal(next.draft, undefined);
  });

  test('cancelling one dialog leaves the other open', () => {
    assert.equal(cancelDraft(busy).draft, undefined);
    assert.equal(cancelDraft(busy).editing, busy.editing);
    assert.equal(cancelRename(busy).editing, undefined);
    assert.equal(cancelRename(busy).draft, busy.draft);
  });
});

describe('the delete dialog', () => {
  test('opens on request and dismisses while no delete is in flight', () => {
    const open = requestDelete(emptySidebar, renamingProject);
    assert.deepEqual(open.deleting, renamingProject);
    assert.equal(dismissDelete(open).deleting, undefined);
  });

  test('stays open while the delete it confirms is in flight', () => {
    const pending = beginDelete(busy);
    assert.equal(pending.deletingPending, true);
    assert.equal(pending.error, undefined);

    const dismissed = dismissDelete(pending);
    assert.deepEqual(dismissed.deleting, busy.deleting);

    const settled = settleDelete(pending);
    assert.equal(settled.deletingPending, false);
    assert.deepEqual(settled.deleting, busy.deleting);
  });

  test('forgets the entity only once its delete landed', () => {
    assert.equal(clearDeleting(busy).deleting, undefined);
  });
});

describe('the draft a settled create closes', () => {
  test('closes any Project draft and leaves a Thread draft alone', () => {
    assert.equal(clearProjectDraft(beginProject(busy)).draft, undefined);
    const threadDraft = beginThread(busy, 'project');
    assert.equal(clearProjectDraft(threadDraft).draft, threadDraft.draft);
  });

  test('closes the Thread draft it was created from, not a newer one', () => {
    const createdFrom: Draft = { kind: 'thread', projectId: 'project' };
    const newer: Draft = { kind: 'thread', projectId: 'other' };
    assert.equal(
      clearThreadDraft({ ...busy, draft: newer }, createdFrom).draft,
      newer,
    );
    assert.equal(
      clearThreadDraft({ ...busy, draft: createdFrom }, createdFrom).draft,
      undefined,
    );
  });

  test('closes the rename of the entity that finished, not another one', () => {
    const rename = startRename(busy, renamingProject);
    assert.equal(clearRename(rename, renamingProject).editing, undefined);
    assert.deepEqual(
      clearRename(rename, renamingThread).editing,
      renamingProject,
    );
    // A rename the user started meanwhile is newer and stays.
    const newer = startRename(busy, renamingThread);
    assert.deepEqual(
      clearRename(newer, renamingProject).editing,
      renamingThread,
    );
  });
});

describe('the one error a failed request surfaces (§8)', () => {
  const refused: ErrorInfo = errorFrom('internal', 'The host refused.');
  const broke: ErrorInfo = errorFrom('project_stream_failed', 'Stream broke.');

  test('fail stores the error with its retry target, or with none', () => {
    assert.deepEqual(fail(emptySidebar, refused, { kind: 'projects' }).error, {
      error: refused,
      retry: { kind: 'projects' },
    });
    assert.deepEqual(
      fail(emptySidebar, refused, { kind: 'threads', projectId: 'project' })
        .error,
      { error: refused, retry: { kind: 'threads', projectId: 'project' } },
    );
    const write = fail(emptySidebar, refused).error;
    assert.deepEqual(write?.error, refused);
    assert.equal(write?.retry, undefined);
  });

  test('fail replaces an earlier error and keeps everything else', () => {
    const failed = fail(busy, refused);
    assert.deepEqual(failed.error?.error, refused);
    assert.equal(failed.error?.retry, undefined);
    assert.deepEqual(failed.draft, busy.draft);
    assert.deepEqual(failed.editing, busy.editing);
    assert.deepEqual(failed.deleting, busy.deleting);
  });

  test('report stores an error the host carried, with no target, and clears on ask', () => {
    const reported = report(
      fail(emptySidebar, refused, { kind: 'projects' }),
      broke,
    );
    assert.deepEqual(reported.error?.error, broke);
    assert.equal(reported.error?.retry, undefined);
    assert.equal(clearError(reported).error, undefined);
  });

  test('settle clears only an error whose target is the loaded one', () => {
    const projects = fail(emptySidebar, refused, { kind: 'projects' });
    assert.equal(settle(projects, { kind: 'projects' }).error, undefined);

    const threads = fail(emptySidebar, refused, {
      kind: 'threads',
      projectId: 'project',
    });
    assert.equal(
      settle(threads, { kind: 'threads', projectId: 'project' }).error,
      undefined,
    );
    // Another Project's Threads, or the Projects list, is another target.
    assert.equal(
      settle(threads, { kind: 'threads', projectId: 'other' }),
      threads,
    );
    assert.equal(settle(threads, { kind: 'projects' }), threads);
    assert.equal(
      settle(projects, { kind: 'threads', projectId: 'project' }),
      projects,
    );
    // An error with no target stays.
    const write = fail(emptySidebar, refused);
    assert.equal(settle(write, { kind: 'projects' }), write);
    assert.equal(settle(emptySidebar, { kind: 'projects' }), emptySidebar);
  });
});

describe('the room a Thread row keeps for its trailing slot (T-25, thread-archive §10.1)', () => {
  const hoverAt = (pr: string) =>
    ` group-hover/tree-row:${pr} group-has-[:focus-visible]/tree-row:${pr}`;
  const cases: readonly ['none' | 'mark' | 'badge', 0 | 1 | 2 | 3, string][] = [
    ['none', 0, 'pr-1.5'],
    ['none', 1, `pr-1.5${hoverAt('pr-8')}`],
    ['none', 2, `pr-1.5${hoverAt('pr-14')}`],
    ['none', 3, `pr-1.5${hoverAt('pr-20')}`],
    ['mark', 0, 'pr-7'],
    ['mark', 1, `pr-7${hoverAt('pr-8')}`],
    ['mark', 2, `pr-7${hoverAt('pr-14')}`],
    ['mark', 3, `pr-7${hoverAt('pr-20')}`],
    ['badge', 0, 'pr-14'],
    ['badge', 1, 'pr-14'],
    ['badge', 2, 'pr-14'],
    ['badge', 3, `pr-14${hoverAt('pr-20')}`],
  ];

  for (const [rest, hover, classes] of cases) {
    test(`rest ${rest} with ${hover} hover actions is "${classes}"`, () => {
      assert.equal(threadRowPadding(rest, hover), classes);
    });
  }
});
