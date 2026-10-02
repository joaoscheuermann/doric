import { type Draft, type Entity, messageFrom } from './workspace';

/**
 * The workspace sidebar's transient state: the dialog in progress and the one
 * error a failed request surfaces. Everything else the sidebar draws — the
 * Projects, the Threads, the selection — lives in the Project tree.
 */
export type Sidebar = {
  readonly draft?: Draft;
  readonly editing?: Entity;
  readonly deleting?: Entity;
  readonly deletingPending: boolean;
  readonly error?: string;
};

export const emptySidebar: Sidebar = { deletingPending: false };

/** Opens the new-Project draft, replacing whatever dialog was open. */
export const beginProject = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  draft: { kind: 'project' },
  editing: undefined,
  error: undefined,
});

/** Opens the new-Thread draft, replacing whatever dialog was open. */
export const beginThread = (
  sidebar: Sidebar,
  projectId: string,
  parentThreadId?: string,
): Sidebar => ({
  ...sidebar,
  draft: { kind: 'thread', projectId, parentThreadId },
  editing: undefined,
  error: undefined,
});

/**
 * Selecting a Project starts the sidebar over: the draft and rename go, and so
 * does the error the user just acted on.
 */
export const selectProject = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  draft: undefined,
  editing: undefined,
  error: undefined,
});

/** Selecting a Thread drops the draft and rename but keeps the error. */
export const selectThread = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  draft: undefined,
  editing: undefined,
});

export const cancelDraft = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  draft: undefined,
});

export const cancelRename = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  editing: undefined,
});

/** Starting a rename replaces any draft beside it. */
export const startRename = (sidebar: Sidebar, entity: Entity): Sidebar => ({
  ...sidebar,
  draft: undefined,
  editing: entity,
});

export const requestDelete = (sidebar: Sidebar, entity: Entity): Sidebar => ({
  ...sidebar,
  deleting: entity,
});

/** The delete dialog stays open while the delete it confirms is in flight. */
export const dismissDelete = (sidebar: Sidebar): Sidebar =>
  sidebar.deletingPending ? sidebar : { ...sidebar, deleting: undefined };

/** A confirmed delete holds its dialog and drops the error it answered. */
export const beginDelete = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  deletingPending: true,
  error: undefined,
});

export const settleDelete = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  deletingPending: false,
});

/** The deleted entity's dialog is done. */
export const clearDeleting = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  deleting: undefined,
});

/**
 * A created Project closes the draft it came from — any Project draft — but
 * leaves a draft of another kind alone.
 */
export const clearProjectDraft = (sidebar: Sidebar): Sidebar =>
  sidebar.draft?.kind === 'project'
    ? { ...sidebar, draft: undefined }
    : sidebar;

/**
 * A created Thread closes the exact draft it was created from: a draft the
 * user started meanwhile is newer and stays.
 */
export const clearThreadDraft = (sidebar: Sidebar, draft: Draft): Sidebar =>
  sidebar.draft === draft ? { ...sidebar, draft: undefined } : sidebar;

/** A finished rename closes it, unless the user already renamed something else. */
export const clearRename = (sidebar: Sidebar, entity: Entity): Sidebar =>
  sidebar.editing?.kind === entity.kind &&
  sidebar.editing.value.id === entity.value.id
    ? { ...sidebar, editing: undefined }
    : sidebar;

/**
 * The one way a failed request reaches the user. Node reports a rejected IPC
 * call as an `Error`, and anything else becomes the fallback message.
 */
export const fail = (sidebar: Sidebar, reason: unknown): Sidebar => ({
  ...sidebar,
  error: messageFrom(reason),
});

/** A message the host already carried, such as a live update's own error. */
export const report = (sidebar: Sidebar, message: string): Sidebar => ({
  ...sidebar,
  error: message,
});

export const clearError = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  error: undefined,
});
