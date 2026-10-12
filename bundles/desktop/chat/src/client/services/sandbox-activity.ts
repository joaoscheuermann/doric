// D9-10: a held conversation that saw a sandbox-writing tool completion, or
// a Thread whose working directory or state changed, tells the files/Git
// refresh coordinator through `onSandboxActivityHook`, once per Project per
// store change, exactly when `use-project-refresh.ts` refreshed it before.

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
