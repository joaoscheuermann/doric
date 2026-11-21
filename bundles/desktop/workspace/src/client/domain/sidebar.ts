import type { ErrorInfo } from 'desktop/reads';

import type { Draft, Entity } from './workspace.js';

const ROW_PADDING = {
  none: [
    'pr-1.5',
    'pr-1.5 group-hover/tree-row:pr-8 group-has-[:focus-visible]/tree-row:pr-8',
    'pr-1.5 group-hover/tree-row:pr-14 group-has-[:focus-visible]/tree-row:pr-14',
    'pr-1.5 group-hover/tree-row:pr-20 group-has-[:focus-visible]/tree-row:pr-20',
  ],
  mark: [
    'pr-7',
    'pr-7 group-hover/tree-row:pr-8 group-has-[:focus-visible]/tree-row:pr-8',
    'pr-7 group-hover/tree-row:pr-14 group-has-[:focus-visible]/tree-row:pr-14',
    'pr-7 group-hover/tree-row:pr-20 group-has-[:focus-visible]/tree-row:pr-20',
  ],
  badge: [
    'pr-14',
    'pr-14',
    'pr-14',
    'pr-14 group-hover/tree-row:pr-20 group-has-[:focus-visible]/tree-row:pr-20',
  ],
} as const;

/**
 * The Thread row button's right padding, as Tailwind classes, so the name
 * truncates before the trailing slot (docs/designs/thread-archive.md §10.1).
 * `rest`: what the trailing slot shows at rest — nothing, a 14 px mark (pin
 * or archive) at `right-2`, or the elapsed badge. `hover`: how many 20 px
 * hover actions the row draws (at `right-1`, `right-7`, `right-13`).
 *
 * The padding clears the rest slot plus 6 px at rest, and the leftmost hover
 * action plus 8 px on row hover or keyboard focus, never less than at rest.
 * Every answer is one of these complete literals, so the sheets that scan
 * this source emit them:
 *
 * | rest    | hover | classes                                                                         |
 * | ------- | ----- | ------------------------------------------------------------------------------- |
 * | `none`  | 0     | `'pr-1.5'`                                                                      |
 * | `none`  | 1     | `'pr-1.5 group-hover/tree-row:pr-8 group-has-[:focus-visible]/tree-row:pr-8'`   |
 * | `none`  | 2     | `'pr-1.5 group-hover/tree-row:pr-14 group-has-[:focus-visible]/tree-row:pr-14'` |
 * | `none`  | 3     | `'pr-1.5 group-hover/tree-row:pr-20 group-has-[:focus-visible]/tree-row:pr-20'` |
 * | `mark`  | 0     | `'pr-7'`                                                                        |
 * | `mark`  | 1     | `'pr-7 group-hover/tree-row:pr-8 group-has-[:focus-visible]/tree-row:pr-8'`     |
 * | `mark`  | 2     | `'pr-7 group-hover/tree-row:pr-14 group-has-[:focus-visible]/tree-row:pr-14'`   |
 * | `mark`  | 3     | `'pr-7 group-hover/tree-row:pr-20 group-has-[:focus-visible]/tree-row:pr-20'`   |
 * | `badge` | 0     | `'pr-14'`                                                                       |
 * | `badge` | 1     | `'pr-14'`                                                                       |
 * | `badge` | 2     | `'pr-14'`                                                                       |
 * | `badge` | 3     | `'pr-14 group-hover/tree-row:pr-20 group-has-[:focus-visible]/tree-row:pr-20'`  |
 *
 * `('none', 1)` is the old addable row and `('badge', 1)` the old timed one:
 * a badge row keeps 56 px on hover, which already holds up to two hover
 * actions, so its name does not truncate again. Pure; never throws.
 */
export const threadRowPadding = (
  rest: 'none' | 'mark' | 'badge',
  hover: 0 | 1 | 2 | 3,
): string => ROW_PADDING[rest][hover];

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
 * What `retryError` loads again for a failed load (§8): the Projects list,
 * or one Project's Threads. Plain data; two targets are the same target when
 * their `kind` and, for `threads`, their `projectId` are equal.
 */
export type WorkspaceRetry =
  | { readonly kind: 'projects' }
  | { readonly kind: 'threads'; readonly projectId: string };

/**
 * The one workspace error (§8): the failure as `ErrorInfo`, and the load to
 * repeat for it. `retry` is set only for a failed load; a failed create,
 * rename, color change, delete, copy or project stream has none, so no
 * notice offers Retry for it.
 */
export interface WorkspaceError {
  readonly error: ErrorInfo;
  readonly retry?: WorkspaceRetry;
}

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
  readonly error?: WorkspaceError;
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
 * The one way a failed request reaches the user: `error` replaces any error
 * the sidebar holds, with `retry` as its target (absent: no target).
 * Everything else in the sidebar is kept.
 */
export const fail = (
  sidebar: Sidebar,
  error: ErrorInfo,
  retry?: WorkspaceRetry,
): Sidebar => ({
  ...sidebar,
  error: retry === undefined ? { error } : { error, retry },
});

/**
 * An error the host already carried, such as a live update's own error, or
 * one the window built (a failed copy): replaces any error the sidebar holds,
 * with no retry target. Everything else in the sidebar is kept.
 */
export const report = (sidebar: Sidebar, error: ErrorInfo): Sidebar => ({
  ...sidebar,
  error: { error },
});

/** Whether two retry targets name the same load. */
const sameTarget = (left: WorkspaceRetry, right: WorkspaceRetry): boolean =>
  left.kind === 'projects'
    ? right.kind === 'projects'
    : right.kind === 'threads' && left.projectId === right.projectId;

/**
 * A load of `target` succeeded: clears the error when its stored retry
 * target is the same target (§8), and returns `sidebar` unchanged (the same
 * object) otherwise — an error with no target, or with another target, stays.
 */
export const settle = (sidebar: Sidebar, target: WorkspaceRetry): Sidebar => {
  const stored = sidebar.error?.retry;
  return stored !== undefined && sameTarget(stored, target)
    ? { ...sidebar, error: undefined }
    : sidebar;
};

export const clearError = (sidebar: Sidebar): Sidebar => ({
  ...sidebar,
  error: undefined,
});
