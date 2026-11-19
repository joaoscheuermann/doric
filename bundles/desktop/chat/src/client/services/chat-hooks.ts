// The owner handle of `chat.hooks/v2`, defined once at activation; the
// surface executes `onMountHook`, `onUnmountHook`, `onBeforeRenderBlockHook`
// and `onThreadUpdateHook` through it.

import type { HookHandle } from 'bundle/contracts';

import type { ChatHooksV2 } from '../../contracts/index.js';

/** The owner handle of `chat.hooks/v2`. */
export type ChatHooks = HookHandle<typeof ChatHooksV2>;

/**
 * What the surfaces execute: every hook but `onSandboxActivityHook`, which
 * only `watchSandboxActivity` executes.
 */
export type SurfaceChatHooks = Omit<ChatHooks, 'onSandboxActivityHook'>;

let current: SurfaceChatHooks | undefined;

export const chatHooks = (): SurfaceChatHooks | undefined => current;

export const setChatHooks = (hooks: SurfaceChatHooks | undefined): void => {
  current = hooks;
};
