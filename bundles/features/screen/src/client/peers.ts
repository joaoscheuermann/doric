// The client contracts the screen part calls, built from their IDs with the
// owner's shape narrowed to what it reads (as `terminal` reaches the
// layout's peers). Importing `layout/contracts` here would close a cycle:
// the layout sits above and screen only reads the selection.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

/** The fields of a Thread record this part reads. */
export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
}

/** The fields of a Project record this part reads (its name labels a view). */
export interface ProjectRecord {
  readonly id: string;
  readonly name?: string;
}

/** The selection the workspace shows; a Project-only selection has no Thread. */
export interface WorkspaceSelection {
  readonly project?: ProjectRecord;
  readonly thread?: ThreadRecord;
}

/** `layout.workspace/v1` (1.1.0), for the selection only. */
export interface LayoutWorkspace {
  selectedThread(call?: CallArg): ThreadRecord | undefined;
  selection(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');

/**
 * The group this part puts in the sidebar's stack (`layout.stack/v2`): the
 * layout draws one group per pane under the Thread region, pinned to the
 * column's bottom — its header (this pane's title and its collapse control)
 * and, while the pane is open, the element `tag` names, as tall as its content
 * up to 40% of the column and scrolling past that. A pane never collapses past
 * its header, so the group cannot vanish.
 */
export interface StackPane {
  /** Unique in the stack; a duplicate fails with `registration_conflict`. */
  readonly id: string;
  /** Top to bottom: ascending, absent last, then registration order. */
  readonly order?: number;
  /** The header text the layout draws. */
  readonly title: string;
  /** The custom element `ui/v1` creates for the group's rows. */
  readonly tag?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  /** An element drawn inside the header, where this group's action belongs. */
  readonly headerTag?: string;
  /** Whether the reader can collapse the pane (default `true`). */
  readonly collapsible?: boolean;
  /** Whether the pane starts expanded (default `true`); collapsed, it starts at its header. */
  readonly initiallyOpen?: boolean;
}

/** `layout.stack/v2` (2.0.0), for the Screens pane. */
export interface LayoutStack {
  register(pane: StackPane, call?: CallArg): Disposable;
}

export const LayoutStackV2 = ref<LayoutStack>('layout.stack/v2');
