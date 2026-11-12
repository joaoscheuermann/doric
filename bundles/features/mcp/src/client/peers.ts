// The layout's client contracts the MCP part calls, built from their IDs with
// the owner's shape narrowed to what it reads (as `screen` reaches them).
// Importing `layout/contracts` here would close a cycle: the layout sits above
// and this part only reads the selection and registers its pane.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

/** The selection the workspace shows; this part reads its Project's id only. */
interface WorkspaceSelection {
  readonly project?: { readonly id: string };
}

/** `layout.workspace/v1` (1.1.0), for the selection only. */
export interface LayoutWorkspace {
  selection(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');

/**
 * The group this part puts in the sidebar's stack (`layout.stack/v2`): the
 * layout draws one group per pane under the Thread region, pinned to the
 * column's bottom — its header (the title and the collapse control) and, while
 * the pane is open, the element `tag` names, as tall as its content up to 40%
 * of the column and scrolling past that.
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
  /** An element drawn inside the header, where this group's action belongs. */
  readonly headerTag?: string;
  /** Whether the reader can collapse the pane (default `true`). */
  readonly collapsible?: boolean;
  /** Whether the pane starts expanded (default `true`); collapsed, it starts at its header. */
  readonly initiallyOpen?: boolean;
}

/** `layout.stack/v2` (2.0.0), for the MCP pane. */
export interface LayoutStack {
  register(pane: StackPane, call?: CallArg): Disposable;
}

export const LayoutStackV2 = ref<LayoutStack>('layout.stack/v2');
