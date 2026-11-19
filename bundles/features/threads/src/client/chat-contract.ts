// The threads client's view of chat's `chat.views/v1` (R-9.7). Threads reads
// it through `whenAvailable` only, so it keeps a structural copy of what it
// uses instead of importing the chat package; the IDs and shapes are chat's.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';
import type { ErrorInfo } from 'desktop/reads';

import type { DelegatedInput } from './domain/delegated.js';

/** One persisted event of a Thread, as the conversation receives it (chat's `ChatThreadEvent`). */
export interface ChatThreadEvent {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  /** The row's payload as stored, which still carries its own `type` key. */
  readonly event: unknown;
  readonly createdAt: string;
}

/** What a projector draws for one or more events of the log (chat's `ChatBlock`). */
interface ChatBlock {
  readonly id: string;
  readonly type: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly data: unknown;
}

/**
 * A projector of event types the built-in projection does not claim (chat's
 * `ProjectorSpec`). It must be pure: replay and rewind run it again over the
 * same events, so the same events always give the same blocks.
 */
export interface ProjectorSpec<S = unknown> {
  /** Exact event types this projector owns; a type already claimed makes `registerProjector` throw `registration_conflict`. */
  readonly eventTypes: readonly string[];
  initial(): S;
  reduce(
    state: S,
    event: ChatThreadEvent,
  ): { readonly state: S; readonly blocks: readonly ChatBlock[] };
}

/** 1.2.0: how the chat draws the calls of one tool (chat's `ToolRendererSpec`). */
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

export interface ChatViews {
  registerRenderer(
    spec: { readonly blockType: string; readonly elementTag: string },
    call?: CallArg,
  ): Disposable;
  /**
   * Claims `spec.eventTypes` for this bundle's projector. Throws
   * `registration_conflict` when another projector, or the built-in
   * projection, already holds one of them; nothing is claimed then.
   * Disposing releases the claim.
   */
  registerProjector(spec: ProjectorSpec, call?: CallArg): Disposable;
  /**
   * 1.2.0. While the returned `Disposable` lives, every call of
   * `spec.toolName` is drawn by one `spec.elementTag` element per call, with
   * its `view`. Throws `registration_conflict` when another bundle holds the
   * name.
   */
  registerToolRenderer(spec: ToolRendererSpec, call?: CallArg): Disposable;
}

export const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

/**
 * The one event a tool element dispatches when the reader opens or closes its
 * block, `detail: { chosen }` (chat's `CHAT_BLOCK_CHOSEN_EVENT`).
 */
export const CHAT_BLOCK_CHOSEN_EVENT = 'chat-block-chosen';

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
