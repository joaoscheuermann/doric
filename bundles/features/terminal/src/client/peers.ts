// The client contracts this part calls, built from their IDs with the owners'
// shapes narrowed to what it reads (as `layout` and `notifications` reach
// their peers): `layout` and `files` sit above the runtime, which imports
// `terminal/contracts`, so importing their contracts modules would close a
// cycle between the projects.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

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
  setBottomVisible(itemId: string, visible: boolean, call?: CallArg): void;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');

/** `layout.tabs/v1` (1.1.0). */
export interface LayoutTabs {
  open(
    input: {
      readonly id: string;
      readonly title: string;
      readonly tag: string;
      readonly props?: Readonly<Record<string, unknown>>;
      readonly icon?: 'file' | 'file-diff' | 'terminal';
    },
    call?: CallArg,
  ): Promise<void>;
  close(
    input: { readonly id: string; readonly threadId?: string },
    call?: CallArg,
  ): Promise<void>;
}

export const LayoutTabsV1 = ref<LayoutTabs>('layout.tabs/v1');

/** Rows a bundle adds under each Thread of the sidebar tree. */
export interface ThreadRows {
  readonly id: string;
  readonly tag: string;
  count(threadId: string): number;
  subscribe(listener: () => void): Disposable;
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
