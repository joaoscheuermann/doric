// The chat's `chat.views/v1`, as `files` reads it (bundle isolation 5(b)):
// `files` draws the calls of `edit`, `write` and `view-image` through it while
// the chat serves it. Only the chat's types are imported; the reference is
// built here, so no chat code is loaded.

import { ref } from 'bundle/contracts';
import type { ChatViews, ToolRendererSpec } from 'chat/contracts';

import { EDIT_CALL_TAG } from './edit-call.js';

export const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

/**
 * How `files` draws its tools' calls: `edit` and `write` by `files-edit-call`,
 * each a block of its own and open until the reader folds it; `view-image` by
 * the chat's generic row, open until the reader folds it, so the image the
 * agent looked at stands beside it.
 */
export const filesToolRenderers: readonly ToolRendererSpec[] = [
  {
    toolName: 'edit',
    elementTag: EDIT_CALL_TAG,
    standalone: true,
    openByDefault: true,
  },
  {
    toolName: 'write',
    elementTag: EDIT_CALL_TAG,
    standalone: true,
    openByDefault: true,
  },
  { toolName: 'view-image', openByDefault: true },
];
