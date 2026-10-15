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
 * The group this part puts in the sidebar's stack (1.0.0): the layout draws one
 * resizable panel per pane, its header (this pane's title and its collapse
 * control) and, when the pane is open, the element `tag` names. A pane never
 * collapses past its header, so the group cannot vanish while the sidebar is
 * resized.
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
  /** Whether the pane starts expanded (default `true`). */
  readonly initiallyOpen?: boolean;
  /** Size when expanded; absent, the pane takes what the others leave. */
  readonly defaultSize?: number | string;
  /** Smallest size while expanded (for example `'20%'`). */
  readonly minSize?: string;
  /** Largest size (for example `'80%'`). */
  readonly maxSize?: string;
}

/** `layout.stack/v1` (1.0.0), for the Screens pane. */
export interface LayoutStack {
  register(pane: StackPane, call?: CallArg): Disposable;
}

export const LayoutStackV1 = ref<LayoutStack>('layout.stack/v1');
