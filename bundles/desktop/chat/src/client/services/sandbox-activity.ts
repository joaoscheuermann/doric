// D9-10: a held conversation that saw a sandbox-writing tool completion, or
// a Thread whose working directory or state changed, tells the files/Git
// refresh coordinator through `onSandboxActivityHook`, once per Project per
// store change, exactly when `use-project-refresh.ts` refreshed it before.
// Bundle isolation 5(c): `chat.hooks/v2` hears the lifecycle causes only.

import type { HookHandle } from 'bundle/contracts';

import type { ChatHooksV1 } from '../../contracts/index.js';
import { changedSandboxProjects } from '../domain/project-refresh.js';
import type { ThreadChatsStore } from '../stores/thread-chats.js';
import type { ChatHooks } from './chat-hooks.js';

type SandboxActivity = Pick<ChatHooks, 'onSandboxActivityHook'>;

const tell = (hooks: SandboxActivity, projects: ReadonlySet<string>): void => {
  for (const projectId of projects) {
    try {
      void hooks.onSandboxActivityHook
        .execute({ projectId })
        .catch(() => undefined);
    } catch {
      // A refresh trigger is never a conversation failure.
    }
  }
};

/**
 * `hooks` (v1) hears every Project `changedSandboxProjects` names; `next`
 * (v2), when given, only those of the lifecycle causes.
 */
export const watchSandboxActivity = (
  store: ThreadChatsStore,
  hooks: Pick<HookHandle<typeof ChatHooksV1>, 'onSandboxActivityHook'>,
  next?: Pick<ChatHooks, 'onSandboxActivityHook'>,
): (() => void) =>
  store.subscribe((state, previous) => {
    tell(hooks, changedSandboxProjects(previous.chats, state.chats));
    if (next)
      tell(
        next,
        changedSandboxProjects(previous.chats, state.chats, {
          toolCalls: false,
        }),
      );
  });
