// The client contracts this part calls, re-exported from their owners'
// contracts modules so every file of the part names them in one place. The
// runtime no longer imports `terminal/contracts` (bundle isolation 7(c)), so
// `runtime`, `workspace`, `layout` and `chat` sit below this bundle and their
// contracts are imported, not copied. Two exceptions remain:
//
// - `chat` is optional (`chat.views/v1` is listed under `optional`), so its
//   module is imported for types only: a window without the chat bundle loads
//   nothing of it. `ChatViewsV1` is a ref built from its ID, and the event
//   name a local literal checked against the chat's constant.
// - `files.refresh/v1` stays a structural copy: `files` imports
//   `terminal/contracts`, so importing `files/contracts` here would close a
//   cycle between the two projects.

import { type CallArg, ref } from 'bundle/contracts';
import type {
  CHAT_BLOCK_CHOSEN_EVENT as ChatBlockChosenEvent,
  ChatViews,
} from 'chat/contracts';
import type { RuntimeRecords, Thread } from 'runtime/contracts';

export type {
  ChatInputView,
  ChatToolView,
  ChatViews,
  InputRendererSpec,
  ToolRendererSpec,
} from 'chat/contracts';
export {
  type CurrentTab,
  type LayoutTabs,
  LayoutTabsV2,
  type TabMenuItem,
  type TabRequest,
} from 'layout/contracts';
export { RuntimeRecordsV1 } from 'runtime/contracts';
export {
  type ThreadRows,
  type WorkspaceSelection,
  type WorkspaceSelectionService,
  WorkspaceSelectionV1,
  type WorkspaceSidebar,
  WorkspaceSidebarV1,
} from 'workspace/contracts';

/** The fields of a Thread record this part reads. */
export type ThreadRecord = Pick<Thread, 'id' | 'projectId' | 'parentThreadId'>;

/** `runtime.records/v1`, narrowed to the Thread fields this part reads. */
export interface RecordsSource extends Pick<RuntimeRecords, 'subscribe'> {
  thread(threadId: string, call?: CallArg): ThreadRecord | undefined;
}

/** `files.refresh/v1` (1.0.0), for `request` only. */
export interface FilesRefresh {
  request(
    projectId: string,
    options?: { readonly periodic?: boolean },
    call?: CallArg,
  ): void;
}

export const FilesRefreshV1 = ref<FilesRefresh>('files.refresh/v1');

/** `chat.views/v1`, by its ID: the chat is optional (see above). */
export const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

/**
 * The one event a chat element dispatches when the reader opens or closes its
 * block, `detail: { chosen }` (chat's `CHAT_BLOCK_CHOSEN_EVENT`).
 */
export const CHAT_BLOCK_CHOSEN_EVENT =
  'chat-block-chosen' satisfies typeof ChatBlockChosenEvent;
