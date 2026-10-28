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
 * The group this part puts in the sidebar's stack (1.0.0): the layout draws one
 * resizable panel per pane, its header (the title and the collapse control)
 * and, when the pane is open, the element `tag` names.
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
  /** Whether the pane starts expanded (default `true`). */
  readonly initiallyOpen?: boolean;
  /** Smallest size while expanded (for example `'20%'`). */
  readonly minSize?: string;
  /** Largest size (for example `'80%'`). */
  readonly maxSize?: string;
}

/** `layout.stack/v1` (1.0.0), for the MCP pane. */
export interface LayoutStack {
  register(pane: StackPane, call?: CallArg): Disposable;
}

export const LayoutStackV1 = ref<LayoutStack>('layout.stack/v1');
