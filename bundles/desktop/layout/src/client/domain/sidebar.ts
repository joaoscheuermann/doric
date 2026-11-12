import { messageFrom } from './errors.js';
import type { Draft, Entity } from './workspace.js';

/**
 * The Thread row button's right padding, as Tailwind classes, so the name
 * truncates before the trailing slot (§4 table). `timed`: the row is active
 * with a badge start, so its elapsed badge shows. `addable`: the row has the
 * plus.
 *
 * | timed | addable | classes                                                              |
 * | ----- | ------- | -------------------------------------------------------------------- |
 * | true  | either  | `'pr-14'` (56 px at rest and on hover or keyboard focus)             |
 * | false | true    | `'pr-1.5 group-hover/tree-row:pr-8 group-has-[:focus-visible]/tree-row:pr-8'` |
 * | false | false   | `'pr-1.5'`                                                           |
 *
 * A timed row keeps 56 px on hover, which already holds the 20 px plus at
 * `right-1`, so its name does not truncate again.
 */
export const threadRowPadding = (timed: boolean, addable: boolean): string => {
  if (timed) return 'pr-14';
  return addable
    ? 'pr-1.5 group-hover/tree-row:pr-8 group-has-[:focus-visible]/tree-row:pr-8'
    : 'pr-1.5';
};

/**
 * A tree row's fill, on its `group/tree-row` wrapper
 * (docs/designs/sidebar-alignment.md §11.1): a selected row is filled in the
 * accent; an unselected one draws the ghost hover fill under the pointer and
 * the ghost pressed fill while pressed. Complete literals, so the sheets that
 * scan this source emit them.
 */
export const rowFill = (selected: boolean): string =>
  selected
    ? 'rounded-[4px] bg-sidebar-accent'
    : 'rounded-[4px] hover:bg-[var(--paper-ghost-hover)] active:bg-[var(--paper-ghost-pressed)]';

/**
 * The row outline: 2 px of --sidebar-ring inset on the wrapper while its
 * treeitem has keyboard focus (§11.3).
 */
export const treeitemRing =
  'has-[[role=treeitem]:focus-visible]:outline-2 has-[[role=treeitem]:focus-visible]:-outline-offset-2 has-[[role=treeitem]:focus-visible]:outline-[var(--sidebar-ring)]';

/**
 * The row outline: 2 px of --sidebar-ring inset on the wrapper while a name
 * field in it has keyboard-visible focus (§11.3).
 */
export const textboxRing =
  'has-[[role=textbox]:focus-visible]:outline-2 has-[[role=textbox]:focus-visible]:-outline-offset-2 has-[[role=textbox]:focus-visible]:outline-[var(--sidebar-ring)]';

/**
 * A row button that draws no fill and no ring: its wrapper draws the fill and
 * the outline.
 */
export const noFillButton =
  'bg-transparent hover:bg-transparent active:bg-transparent data-active:bg-transparent focus-visible:ring-0';

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
