// The drawio bundle's view of chat's `chat.composer/v1`, `chat.send/v1` and
// the composer vocabulary, kept as a structural copy so this bundle does not
// import the `chat` package (`papercraft` does the same,
// `bundles/features/papercraft/src/contracts/chat.ts`). The client and the
// desktop part both read it here; the IDs and shapes are chat's.

import {
  type CallArg,
  type Disposable,
  ref,
  type StreamListener,
} from 'bundle/contracts';

import type { CommentAddInput } from './index.js';

/* `chat.composer/v1` (structural copy) ------------------------------------- */

/**
 * `chat.composer/v1` (desktopMain, cardinality `one`): the host-owned draft of
 * the prompt — its text and the composer stack above it — so a draft survives
 * navigation and serves every window. One stack per Thread; every window
 * subscribes by `threadId`.
 *
 * The exposed methods are plain bridge calls; `registerFlush` carries a
 * function and only serves callers in the main process, so the bundle that
 * owns a kind registers that kind's flush from its own desktop part. Optional
 * (`manifest.json` `optional`): consulted with `services.whenAvailable`.
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
 * every diagram draft names, so the stack draws (and edits) it like any
 * other comment.
 */
export const CHAT_COMMENT_LINE_TAG = 'chat-comment-line';

/**
 * The DOM event chat's `CmdOrCtrl+Enter` (`chat.send-prompt/v1`) dispatches on
 * the document before it reads the stack: a surface holding a note the reader
 * has not confirmed yet confirms it and hands the confirmation to
 * `waitUntil`, so the note goes with the prompt.
 */
export const PROMPT_SEND_EVENT = 'doric:prompt-send';

/** What `PROMPT_SEND_EVENT` carries. */
export interface PromptSendDetail {
  readonly threadId: string;
  waitUntil(pending: Promise<unknown>): void;
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
 * reach the host's contracts; the flush answers with plain data instead). An
 * empty array leaves the item drafted.
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
 * after the host accepts it. Optional (`manifest.json` `optional`).
 */
export interface ChatSend {
  send(
    input: { readonly projectId: string; readonly threadId: string },
    call?: CallArg,
  ): Promise<{ readonly status: 'accepted' | 'empty' | 'refused' }>;
}

export const ChatSendV1 = ref<ChatSend>('chat.send/v1');
