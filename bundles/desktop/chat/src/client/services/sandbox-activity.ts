// D9-10, D12: a Thread the chat starts to hold, whose working directory
// changes or whose run ends tells the files/Git refresh coordinator through
// `chat.hooks/v2` `onSandboxActivityHook`, once per Project per store change.

import { changedSandboxProjects } from '../domain/project-refresh.js';
import type { ThreadChatsStore } from '../stores/thread-chats.js';
import type { ChatHooks } from './chat-hooks.js';

export const watchSandboxActivity = (
  store: ThreadChatsStore,
  hooks: Pick<ChatHooks, 'onSandboxActivityHook'>,
): (() => void) =>
  store.subscribe((next, previous) => {
    for (const projectId of changedSandboxProjects(
      previous.chats,
      next.chats,
    )) {
      try {
        void hooks.onSandboxActivityHook
          .execute({ projectId })
          .catch(() => undefined);
      } catch {
        // A refresh trigger is never a conversation failure.
      }
    }
  });
