// The owner handle of `chat.hooks/v1`, defined once at activation; the
// surface executes `onMountHook`, `onUnmountHook` and
// `onBeforeRenderBlockHook` through it.

import type { HookHandle } from 'bundle/contracts';

import type { ChatHooksV1 } from '../../contracts/index.js';

export type ChatHooks = HookHandle<typeof ChatHooksV1>;

let current: ChatHooks | undefined;

export const chatHooks = (): ChatHooks | undefined => current;

export const setChatHooks = (hooks: ChatHooks | undefined): void => {
  current = hooks;
};
