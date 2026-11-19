// The owner handles of `chat.hooks/v1` and `chat.hooks/v2`, defined once at
// activation; the surface executes `onMountHook`, `onUnmountHook`,
// `onBeforeRenderBlockHook` and `onThreadUpdateHook` through one handle that
// reaches both.

import type { CallArg, HookHandle } from 'bundle/contracts';

import type {
  ChatHooksV1,
  ChatHooksV2,
  RenderBlock,
} from '../../contracts/index.js';

/** The owner handle of `chat.hooks/v2`. */
export type ChatHooks = HookHandle<typeof ChatHooksV2>;

/**
 * What the surfaces execute: every hook but `onSandboxActivityHook`, which
 * only `watchSandboxActivity` executes, on each handle it is given.
 */
export type SurfaceChatHooks = Omit<ChatHooks, 'onSandboxActivityHook'>;

let current: SurfaceChatHooks | undefined;

export const chatHooks = (): SurfaceChatHooks | undefined => current;

export const setChatHooks = (hooks: SurfaceChatHooks | undefined): void => {
  current = hooks;
};

type Observe<I> = { execute(input: I, call?: CallArg): Promise<void> };

/** Runs one execute so that a synchronous throw becomes a rejection. */
const guarded = (run: () => Promise<void>): Promise<void> => {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error);
  }
};

/** Executes both hooks, each in its own guard; rejects if either failed. */
const both = <I>(first: Observe<I>, second: Observe<I>): Observe<I> => ({
  execute: async (input, call) => {
    const results = await Promise.allSettled([
      guarded(() => first.execute(input, call)),
      guarded(() => second.execute(input, call)),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  },
});

/**
 * Bundle isolation 5(c), changes 1–5 only: each `observe` execute goes to
 * both handles (a throw or rejection of one does not stop the other); the
 * `transform` passes the block through v1's registrants, then v2's.
 */
export const bothChatHooks = (
  v1: HookHandle<typeof ChatHooksV1>,
  v2: ChatHooks,
): SurfaceChatHooks => ({
  onMountHook: both(v1.onMountHook, v2.onMountHook),
  onUnmountHook: both(v1.onUnmountHook, v2.onUnmountHook),
  onThreadUpdateHook: both(v1.onThreadUpdateHook, v2.onThreadUpdateHook),
  onBeforeRenderBlockHook: {
    execute: async (input, call): Promise<RenderBlock> => {
      const fromV1 = await v1.onBeforeRenderBlockHook.execute(input, call);
      return v2.onBeforeRenderBlockHook.execute(fromV1, call);
    },
  },
});
