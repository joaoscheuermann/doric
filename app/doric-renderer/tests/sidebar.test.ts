import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

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
  settleDelete,
  startRename,
  threadIconKind,
} from '../src/domain/sidebar';
import type { Draft, Entity, Project, Thread } from '../src/domain/workspace';

const project: Project = {
  id: 'project',
  name: 'project',
  state: 'ready',
  createdAt: '',
  updatedAt: '',
};

const thread: Thread = {
  id: 'thread',
  projectId: 'project',
  name: 'thread',
  state: 'ready',
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
  error: 'Something failed.',
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

describe('the one error a failed request surfaces', () => {
  test('carries the host message, or the fallback when there is none', () => {
    assert.equal(
      fail(emptySidebar, new Error('The host refused.')).error,
      'The host refused.',
    );
    assert.equal(
      fail(emptySidebar, 'not an Error').error,
      'The operation could not be completed.',
    );
  });

  test('reports a message the update already carried, and clears on ask', () => {
    assert.equal(report(emptySidebar, 'Stream broke.').error, 'Stream broke.');
    assert.equal(
      clearError(report(emptySidebar, 'Stream broke.')).error,
      undefined,
    );
  });
});

describe('the icon a thread row leads with', () => {
  test('is an ordinary conversation without the host hint', () => {
    assert.equal(threadIconKind(thread), 'conversation');
  });

  test('is git when the cwd root is a repository', () => {
    assert.equal(threadIconKind({ ...thread, cwdRepo: 'git' }), 'git');
  });

  test('is github only for the GitHub hint', () => {
    assert.equal(threadIconKind({ ...thread, cwdRepo: 'github' }), 'github');
  });
});
