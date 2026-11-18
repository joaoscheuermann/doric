// The client contracts this part calls, built from their IDs with the owners'
// shapes narrowed to what it reads (as `layout` and `notifications` reach
// their peers): `layout`, `files` and `workspace` sit above the runtime, which
// imports `terminal/contracts`, so importing their contracts modules, or the
// runtime's, would close a cycle between the projects (until step 7(c)).

import { type CallArg, type Disposable, ref } from 'bundle/contracts';
import type { ReactNode } from 'react';

/** The fields of a Thread record this part reads. */
export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
}

/** The selected ids `workspace.selection/v1` answers. */
export interface WorkspaceSelection {
  readonly projectId?: string;
  readonly threadId?: string;
}

/** `workspace.selection/v1` (1.0.0). */
export interface WorkspaceSelectionService {
  current(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const WorkspaceSelectionV1 = ref<WorkspaceSelectionService>(
  'workspace.selection/v1',
);

/** `runtime.records/v1` (1.0.0), for the Thread records only. */
export interface RecordsSource {
  thread(threadId: string, call?: CallArg): ThreadRecord | undefined;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const RuntimeRecordsV1 = ref<RecordsSource>('runtime.records/v1');

/** One entry of a viewer tab's context menu (`layout.tabs/v2` 2.0.0). */
export interface TabMenuItem {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  /** The item's 16 px leading icon, a React element. */
  readonly icon?: ReactNode;
  readonly run: () => void;
}

/** What `layout.tabs/v2.open` takes from this part. */
export interface TabRequest {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly props?: Readonly<Record<string, unknown>>;
  /** The element drawn as the trigger's 16 px icon, created with the tab's `props`. */
  readonly iconTag?: string;
  /** The viewer card draws no bottom padding while this tab is selected. */
  readonly openBottom?: boolean;
  /** The entries the tab's context menu shows above "Close tab". */
  readonly menu?: readonly TabMenuItem[];
}

/** The selected tab of the active owner (`layout.tabs/v2` 2.0.0). */
export interface CurrentTab {
  readonly id: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

/** `layout.tabs/v2` (2.0.0). */
export interface LayoutTabs {
  open(input: TabRequest, call?: CallArg): Promise<void>;
  /**
   * Closes the tab with that id among that owner's tabs (the active owner's
   * without `threadId`), or in every owner with `everyOwner`.
   */
  close(
    input: {
      readonly id: string;
      readonly threadId?: string;
      readonly everyOwner?: boolean;
    },
    call?: CallArg,
  ): Promise<void>;
  /**
   * Sets the title of the tab with that id, in the owners `close` would
   * reach; nothing without such a tab.
   */
  retitle(
    input: {
      readonly id: string;
      readonly title: string;
      readonly threadId?: string;
      readonly everyOwner?: boolean;
    },
    call?: CallArg,
  ): Promise<void>;
  /** The selected tab of the active owner, if any (local). */
  current(call?: CallArg): CurrentTab | undefined;
  /** Called after every change of the tabs or of the owner (local). */
  subscribe(listener: () => void, call?: CallArg): Disposable;
  /** Names the set of tabs the frame shows; absent, no set (local). */
  setOwner(input: { readonly owner?: string }, call?: CallArg): void;
}

export const LayoutTabsV2 = ref<LayoutTabs>('layout.tabs/v2');

/** Rows a bundle adds under each Thread of the sidebar tree. */
export interface ThreadRows {
  readonly id: string;
  readonly tag: string;
  count(threadId: string): number;
  subscribe(listener: () => void): Disposable;
  /**
   * `workspace.sidebar/v1` 1.0.0: whether an agent terminal directly under
   * the Thread keeps it active.
   */
  busy?(threadId: string): boolean;
}

/** `workspace.sidebar/v1` (1.0.0). */
export interface WorkspaceSidebar {
  addThreadRows(rows: ThreadRows, call?: CallArg): Disposable;
}

export const WorkspaceSidebarV1 = ref<WorkspaceSidebar>('workspace.sidebar/v1');

/** `files.refresh/v1` (1.0.0), for `request` only. */
export interface FilesRefresh {
  request(
    projectId: string,
    options?: { readonly periodic?: boolean },
    call?: CallArg,
  ): void;
}

export const FilesRefreshV1 = ref<FilesRefresh>('files.refresh/v1');
