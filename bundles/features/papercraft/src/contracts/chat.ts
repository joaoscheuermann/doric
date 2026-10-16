// The papercraft bundle's view of chat's `chat.views/v1`, `chat.composer/v1`
// and the block vocabulary, kept as a structural copy so this bundle does not
// import the `chat` package (the `threads` client does the same). The client
// and the desktop part both read it here; the IDs and shapes are chat's.

import {
  type CallArg,
  type Disposable,
  ref,
  type StreamListener,
} from 'bundle/contracts';

import type { CommentAddInput } from './index.js';

/** One persisted event of a Thread, as the conversation receives it. */
export interface ChatThreadEvent {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
}

/** What a projector draws for one or more events of the log. */
export interface ChatBlock {
  readonly id: string;
  readonly type: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly data: unknown;
}

/** A projector of event types the built-in projection does not claim. It is pure. */
export interface ProjectorSpec<S = unknown> {
  readonly eventTypes: readonly string[];
  initial(): S;
  reduce(
    state: S,
    event: ChatThreadEvent,
  ): { readonly state: S; readonly blocks: readonly ChatBlock[] };
}

/** Which element draws one block type. */
export interface RendererSpec {
  readonly blockType: string;
  readonly elementTag: string;
}

export interface ChatViews {
  registerProjector(spec: ProjectorSpec, call?: CallArg): Disposable;
  registerRenderer(spec: RendererSpec, call?: CallArg): Disposable;
}

export const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

/* `chat.composer/v1` (structural copy) ------------------------------------- */

/**
 * `chat.composer/v1` (desktopMain, cardinality `one`): the host-owned draft of
 * the prompt — its text and the composer stack above it — so a draft survives
 * navigation and serves every window (papercraft.md decisions 14 and 15). One
 * stack per Thread; every window subscribes by `threadId`.
 *
 * The shape below mirrors the real contract, kept as a structural copy so this
 * bundle does not import the `chat` package (the `threads` client does the same
 * for `chat.views/v1`). The exposed methods are plain bridge calls; the one
 * `registerFlush` carries a function and only serves callers in the main
 * process, so the bundle that owns a kind registers that kind's flush from its
 * own desktop part. The gesture keeps a working fallback while nothing answers,
 * consulted with `services.whenAvailable`, like `ChatViewsV1`.
 */

/** One item of the composer's comment stack: a draft until the send flushes it. */
export interface ComposerItem {
  /** The item's identity within the composer, assigned when it is added. */
  readonly id: string;
  /** The kind of comment, declared by the bundle that owns it. */
  readonly kind: string;
  /** The element tag that draws this item's line, resolved as a block's is. */
  readonly elementTag: string;
  /** The owner's payload — the target and anchor of the comment; chat never reads it. */
  readonly data: unknown;
  /** Who wrote the comment; the line's avatar is the jdenticon of this name. */
  readonly author?: string;
  /** The note as written; empty when the item was just picked. */
  readonly note: string;
}

/**
 * The element tag of the line chat itself draws for a stack item — the line
 * every papercraft draft names, so the stack draws (and edits) it like any
 * other comment.
 */
export const CHAT_COMMENT_LINE_TAG = 'chat-comment-line';

/**
 * The bubbling DOM event the conversation dispatches when the reader asks to
 * see a comment's thread (a reply block, a comment marker of a user turn):
 * `detail` names the root comment and its target. The owner of the target
 * opens the thread; every other listener ignores it. A target with a
 * `revision` names that revision; a target without one means the latest — of
 * a preview's nodes in the conversation, the one of its newest revision
 * opens the thread.
 */
export const COMMENT_THREAD_OPEN_EVENT = 'doric:comment-thread-open';

/** What `COMMENT_THREAD_OPEN_EVENT` carries. */
export interface CommentThreadOpenDetail {
  readonly commentId: string;
  readonly target: {
    readonly kind: string;
    readonly id: string;
    readonly revision?: number;
  };
}

/** The draft one Thread holds: its words and its comment stack, one state. */
export interface ComposerSnapshot {
  readonly threadId: string;
  readonly text: string;
  readonly items: readonly ComposerItem[];
}

/** One `chat.composer/v1` watch item: the portrait first, then the live deltas. */
export type ComposerWatchItem =
  | {
      readonly kind: 'snapshot';
      readonly threadId: string;
      readonly text: string;
      readonly items: readonly ComposerItem[];
    }
  | { readonly kind: 'text'; readonly threadId: string; readonly text: string }
  | {
      readonly kind: 'added';
      readonly threadId: string;
      readonly item: ComposerItem;
    }
  | {
      readonly kind: 'updated';
      readonly threadId: string;
      readonly item: ComposerItem;
    }
  | {
      readonly kind: 'removed';
      readonly threadId: string;
      readonly id: string;
    };

/** Where the send runs a flush: the prompt the host just accepted. */
export interface ComposerFlushContext {
  readonly projectId?: string;
  readonly threadId: string;
  readonly promptId: string;
}

/**
 * What the owner of a comment kind turns one of its items into when the send
 * flushes it: the durable comment writes the sender then performs through
 * `comments/v1` (the composer service runs in the main process, which cannot
 * reach the host's contracts; the flush answers with plain data instead).
 */
export type ComposerFlush = (
  item: ComposerItem,
  context: ComposerFlushContext,
) => Promise<readonly CommentAddInput[]>;

/** One item the send took off the stack, with the writes its flush answered. */
export interface ComposerFlushed {
  readonly item: ComposerItem;
  readonly writes: readonly CommentAddInput[];
}

/** The input that adds one item to the Thread's stack. */
export interface ComposerAddInput {
  /** The item's id, when the caller chooses it (`comment-<uuid>`). */
  readonly id?: string;
  readonly threadId: string;
  readonly kind: string;
  readonly elementTag: string;
  readonly data?: unknown;
  readonly author?: string;
  readonly note?: string;
}

/** The owner of a kind registers how its items flush. */
export interface ComposerFlushRegistration {
  readonly kind: string;
  readonly flush: ComposerFlush;
}

export interface ChatComposer {
  /** The Thread's portrait: its draft text and its stack, empty until written. */
  read(
    input: { readonly threadId: string },
    call?: CallArg,
  ): Promise<ComposerSnapshot>;
  /** The portrait first, then the deltas — `runtime.threads/v1.watchThread`'s shape. */
  watch(
    threadId: string,
    listener: StreamListener<ComposerWatchItem>,
    call?: CallArg,
  ): Disposable;
  /** Sets the Thread's draft text; every window's watch sees the delta. */
  setText(
    input: { readonly threadId: string; readonly text: string },
    call?: CallArg,
  ): Promise<void>;
  /** Adds one item to the Thread's stack and returns it with its identity. */
  addItem(input: ComposerAddInput, call?: CallArg): Promise<ComposerItem>;
  /** Edits the note of one stack item — a draft is free to change. */
  updateNote(
    input: {
      readonly threadId: string;
      readonly id: string;
      readonly note: string;
    },
    call?: CallArg,
  ): Promise<void>;
  /** Removes one item from the Thread's stack. */
  removeItem(
    input: { readonly threadId: string; readonly id: string },
    call?: CallArg,
  ): Promise<void>;
  /**
   * Runs the flush each item's kind registered, takes the flushed items off
   * the stack and answers each with its writes; the sender puts an item back
   * when one of its writes fails.
   */
  flush(
    input: { readonly threadId: string; readonly promptId: string },
    call?: CallArg,
  ): Promise<readonly ComposerFlushed[]>;
  /** The owner of a kind registers how its items flush; a second is a conflict. */
  registerFlush(input: ComposerFlushRegistration, call?: CallArg): Disposable;
}

export const ChatComposerV1 = ref<ChatComposer>('chat.composer/v1');

/* `chat.send/v1` (structural copy) ------------------------------------------ */

/**
 * `chat.send/v1` (client, one per window): sends a Thread's comment stack now,
 * as its own prompt — the composer's own send path: the stack's lines with
 * their anchors become the prompt, and the stack flushes into the log only
 * after the host accepts it. The canvas sends with it on `Cmd+Enter`.
 */
export interface ChatSend {
  send(
    input: { readonly projectId: string; readonly threadId: string },
    call?: CallArg,
  ): Promise<{ readonly status: 'accepted' | 'empty' | 'refused' }>;
}

export const ChatSendV1 = ref<ChatSend>('chat.send/v1');
