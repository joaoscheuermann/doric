// The client contracts this part calls, built from their IDs with the owners'
// shapes narrowed to what it reads (as `layout` and `notifications` reach
// their peers): `layout`, `files`, `workspace` and `chat` sit above the runtime, which
// imports `terminal/contracts`, so importing their contracts modules, or the
// runtime's, would close a cycle between the projects (until step 7(c)).

import { type CallArg, type Disposable, ref } from 'bundle/contracts';
import type { ErrorInfo } from 'desktop/reads';
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

/**
 * 1.2.0: how the chat draws the calls of one tool (`chat.views/v1`'s
 * `ToolRendererSpec`). The chat sits above this bundle (until step 7(c)), so
 * these are structural copies of the shapes the terminal's registrations use.
 */
export interface ToolRendererSpec {
  /** The tool's name, as the agent calls it. */
  readonly toolName: string;
  /**
   * The element that draws each call, created through `ui/v1`, one per call,
   * with `view` (`ChatToolView`). Absent, the chat's generic row draws it.
   */
  readonly elementTag?: string;
  /** `true`: the call is a block of its own, outside the activity group. Default `false`. */
  readonly standalone?: boolean;
  /** `true`: the call's block is open until the reader closes it. Default `false`. */
  readonly openByDefault?: boolean;
}

/** 1.2.0: how the chat draws the prompts of one input source (chat's `InputRendererSpec`). */
export interface InputRendererSpec {
  /** A lowercase input source kind other than `user`. */
  readonly source: string;
  /** The element that draws each prompt of the source, created through `ui/v1`. */
  readonly elementTag: string;
}

/**
 * The `view` property the chat sets on a tool element (chat's `ChatToolView`):
 * before it connects, and again (as a new object) whenever a field changes.
 * `key` does not change for the call's life; `status` moves only from
 * `running` to `finished` or `failed`.
 */
export interface ChatToolView {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  /** `${promptId}/${callId}`: stable for the call's life and unique in the Thread. */
  readonly key: string;
  /** The tool's name, as registered. */
  readonly name: string;
  /** One-line JSON of the call's payload. */
  readonly args: string;
  /** The finished call's serialized output; absent while running or when there is none. */
  readonly result?: string;
  /** Why the call failed, whole (causes and time included); absent unless `status` is `failed`. */
  readonly error?: ErrorInfo;
  readonly status: 'running' | 'finished' | 'failed';
  /** The reader's choice of open or closed; `null` while the reader has not chosen. */
  readonly chosen: boolean | null;
  /** Whether the caret rests on the block. */
  readonly focused: boolean;
}

/**
 * The `view` property the chat sets on an input element (chat's
 * `ChatInputView`): before it connects, and again (as a new object) whenever a
 * field changes.
 */
export interface ChatInputView {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  /** The prompt's source, as the log records it; `kind` is never `user`. */
  readonly source: {
    readonly kind: string;
    readonly threadId?: string;
    readonly terminalId?: string;
    readonly bundleId?: string;
    readonly reason?: string;
  };
  /** The prompt's text as the log holds it, framing included. */
  readonly text: string;
  /** The reader's choice of open or closed; `null` while the reader has not chosen. */
  readonly chosen: boolean | null;
  /** Whether the caret rests on the block. */
  readonly focused: boolean;
}

/** `chat.views/v1` (1.2.0), for the two registrations this part makes. */
export interface ChatViews {
  /**
   * While the returned `Disposable` lives, every call of `spec.toolName` is
   * drawn by one `spec.elementTag` element per call. Throws
   * `registration_conflict` when another bundle holds the name.
   */
  registerToolRenderer(spec: ToolRendererSpec, call?: CallArg): Disposable;
  /**
   * While the returned `Disposable` lives, every prompt of `spec.source` is
   * drawn by one `spec.elementTag` element. Throws `registration_conflict`
   * when the source already has a registration.
   */
  registerInputRenderer(spec: InputRendererSpec, call?: CallArg): Disposable;
}

export const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

/**
 * The one event a chat element dispatches when the reader opens or closes its
 * block, `detail: { chosen }` (chat's `CHAT_BLOCK_CHOSEN_EVENT`).
 */
export const CHAT_BLOCK_CHOSEN_EVENT = 'chat-block-chosen';
