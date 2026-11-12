// The client contracts this part calls, built from their IDs with the owners'
// shapes narrowed to what it reads (as `layout` and `notifications` reach
// their peers): `layout` and `files` sit above the runtime, which imports
// `terminal/contracts`, so importing their contracts modules would close a
// cycle between the projects.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';
import type { ReactNode } from 'react';

/** The fields of a Thread record this part reads. */
export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
}

/** `layout.workspace/v1` (1.1.0). */
export interface LayoutWorkspace {
  thread(threadId: string, call?: CallArg): ThreadRecord | undefined;
  selectedThread(call?: CallArg): ThreadRecord | undefined;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');

/** One entry of a viewer tab's context menu (`layout.tabs/v1` 1.2.0). */
export interface TabMenuItem {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  /** 1.2.0: the item's 16 px leading icon, a React element. */
  readonly icon?: ReactNode;
  readonly run: () => void;
}

/** What `layout.tabs/v1.open` takes from this part. */
export interface TabRequest {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly icon?: 'file' | 'file-diff' | 'terminal';
  /** 1.2.0: the entries the tab's context menu shows above "Close tab". */
  readonly menu?: readonly TabMenuItem[];
}

/** The selected tab of the active owner (`layout.tabs/v1` 1.1.0). */
export interface CurrentTab {
  readonly id: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

/** `layout.tabs/v1` (1.2.0). */
export interface LayoutTabs {
  open(input: TabRequest, call?: CallArg): Promise<void>;
  close(
    input: { readonly id: string; readonly threadId?: string },
    call?: CallArg,
  ): Promise<void>;
  /**
   * 1.2.0: sets the title of the tab with that id among that Thread's tabs
   * (the active Thread's without `threadId`); nothing without such a tab.
   */
  retitle(
    input: {
      readonly id: string;
      readonly title: string;
      readonly threadId?: string;
    },
    call?: CallArg,
  ): Promise<void>;
  /** 1.1.0: the selected tab of the active owner, if any (local). */
  current(call?: CallArg): CurrentTab | undefined;
  /** 1.1.0: called after every change of the tabs or of the owner (local). */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutTabsV1 = ref<LayoutTabs>('layout.tabs/v1');

/** Rows a bundle adds under each Thread of the sidebar tree. */
export interface ThreadRows {
  readonly id: string;
  readonly tag: string;
  count(threadId: string): number;
  subscribe(listener: () => void): Disposable;
  /**
   * `layout.sidebar/v1` 1.1.0: whether an agent terminal directly under the
   * Thread keeps it active. A 1.0.0 layout never calls it and ignores it.
   */
  busy?(threadId: string): boolean;
}

/** `layout.sidebar/v1` (1.0.0). */
export interface LayoutSidebar {
  addThreadRows(rows: ThreadRows, call?: CallArg): Disposable;
}

export const LayoutSidebarV1 = ref<LayoutSidebar>('layout.sidebar/v1');

/** `files.refresh/v1` (1.0.0), for `request` only. */
export interface FilesRefresh {
  request(
    projectId: string,
    options?: { readonly periodic?: boolean },
    call?: CallArg,
  ): void;
}

export const FilesRefreshV1 = ref<FilesRefresh>('files.refresh/v1');
