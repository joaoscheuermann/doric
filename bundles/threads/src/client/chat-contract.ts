// The threads client's view of chat's `chat.views/v1` (R-9.7). Threads reads
// it through `whenAvailable` only, so it keeps a structural copy of what it
// uses instead of importing the chat package; the IDs and shapes are chat's.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

import type { DelegatedInput } from './domain/delegated.js';

export interface ChatViews {
  registerRenderer(
    spec: { readonly blockType: string; readonly elementTag: string },
    call?: CallArg,
  ): Disposable;
}

export const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

/** The block type of another Thread's input in this one. */
export const DELEGATED_INPUT_BLOCK = 'chat.delegated-input/v1';

/** The `block` chat hands a delegated-input element. */
export interface DelegatedInputBlock {
  readonly type: typeof DELEGATED_INPUT_BLOCK;
  readonly id: string;
  readonly data: {
    readonly promptId: string;
    readonly input: DelegatedInput;
  };
}

/** The element protocol chat drives: it sets `block` and `focused`, calls `toggle()`, reads `chosen`. */
export interface ChatBlockElement {
  block: unknown;
  focused: boolean;
  toggle(): void;
  readonly chosen: boolean;
}

/** The delegated input a block carries, when it is one. */
export const blockInput = (block: unknown): DelegatedInput | undefined => {
  const input = (block as { data?: { input?: unknown } } | undefined)?.data
    ?.input as Partial<DelegatedInput> | undefined;
  if (
    input === undefined ||
    input === null ||
    (input.kind !== 'parent' && input.kind !== 'result') ||
    typeof input.threadId !== 'string' ||
    typeof input.text !== 'string'
  )
    return undefined;
  return input as DelegatedInput;
};
