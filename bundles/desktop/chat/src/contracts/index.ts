// Public contracts of the `chat` bundle (stage 9, §7.2). They are typed
// references and schemas only; the providers live in the client part.

import {
  type CallArg,
  type Disposable,
  defineHook,
  defineHooks,
  disposableSchema,
  type MethodSpecs,
  ref,
  type StreamListener,
  streamListener,
} from 'bundle/contracts';
import {
  type CommentAddInput,
  type CommentTarget,
  commentAddInputSchema,
} from 'comments/contracts';
import type { AnyLexicalExtension, Klass, LexicalNode } from 'lexical';
import type { Thread, ThreadEvent } from 'runtime/contracts';
import { z } from 'zod';

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

/**
 * A projector of event types the built-in projection does not claim. It is
 * pure: replay and rewind run it again over the same event list.
 */
export interface ProjectorSpec<S = unknown> {
  /** Exact event types this projector owns; a second claim is `registration_conflict`. */
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

export const rendererSpecSchema = z
  .object({ blockType: z.string().min(1), elementTag: z.string().min(1) })
  .strict();

/**
 * 1.1.0 (openui.md D1): which element draws the fences of one tag. A fence
 * whose opener's first info word is `tag` becomes, in an agent turn, an element
 * of `elementTag` instead of a code block, while the registration lives.
 */
export interface FenceRendererSpec {
  /** The tag the opener line names, matched exactly against the info string's first word. */
  readonly tag: string;
  /** The custom element the chat creates through `ui/v1` for each fence of the tag. */
  readonly elementTag: string;
}

/** A fence tag: 1 to 64 characters, no whitespace, backtick or tilde. */
export const fenceTagSchema = z.string().regex(/^[^\s`~]{1,64}$/);

/** `registerFenceRenderer`'s input; an input that fails it is `invalid_input`. */
export const fenceRendererSpecSchema = z
  .object({ tag: fenceTagSchema, elementTag: z.string().min(1) })
  .strict() satisfies z.ZodType<FenceRendererSpec, FenceRendererSpec>;

/**
 * One fence of a registered tag in an agent turn (openui.md D1, D2), as the
 * conversation's own projection computes it.
 *
 * What stays true: `key` does not change while the turn streams, and is unique
 * among the Thread's fences of one tag; `state` moves only from `streaming` to
 * `closed` or `unterminated`.
 */
export interface ChatFence {
  /** `${promptId}/${turnSequence}/${index}` (D2); unique within its tag. */
  readonly key: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  /** `sequence` of the first event of the turn that holds the fence. */
  readonly turnSequence: number;
  /** 0-based, among the fences of this tag in the turn. */
  readonly index: number;
  /** The opener line after its backticks or tildes, trimmed. */
  readonly info: string;
  /** The lines between the opener and the closer (or the end of the turn), joined by `\n`. */
  readonly body: string;
  /**
   * `closed`: the closer line exists. `streaming`: no closer, the turn is the
   * transcript's last turn that is not `queued`, and its prompt has no settled
   * status. `unterminated`: no closer and not `streaming`.
   */
  readonly state: 'streaming' | 'closed' | 'unterminated';
}

/** The `view` property the chat sets on a fence element before it connects. */
export interface ChatFenceView {
  readonly fence: ChatFence;
  /** The Thread's `origin`, `agent` for a subagent's Thread; `'user'` when the Thread has none. */
  readonly origin: 'user' | 'agent';
  /** Every fence of the same tag in the Thread, in transcript order, this one included. */
  readonly fences: readonly ChatFence[];
}

/** `watchFences`' input; an input that fails it is `invalid_input`. */
export const watchFencesInputSchema = z
  .object({
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    tag: fenceTagSchema,
  })
  .strict();

export interface ChatViews {
  registerProjector(spec: ProjectorSpec, call?: CallArg): Disposable;
  registerRenderer(spec: RendererSpec, call?: CallArg): Disposable;
  /**
   * 1.1.0. From now until the returned `Disposable` is disposed, the window's
   * conversations draw every fence of `spec.tag` in an agent turn as one
   * `spec.elementTag` element per fence key, created through `ui/v1` with its
   * `view` (`ChatFenceView`) set, and kept across streaming flushes; shown
   * turns are rebuilt at once, and the reverse happens on dispose.
   *
   * Fails with `registration_conflict` when the tag already has a fence
   * renderer, and `invalid_input` when the spec fails `fenceRendererSpecSchema`
   * or `ui/v1` has not defined `elementTag`; nothing is registered then.
   */
  registerFenceRenderer(spec: FenceRendererSpec, call?: CallArg): Disposable;
  /**
   * 1.1.0. The Thread's fences of `tag`, in transcript order, computed by the
   * same projection the conversation uses: first the whole list, then the
   * whole list again after each flush that changes it (by key, state or body).
   * For a surface outside the conversation, such as the canvas window.
   *
   * The listener gets `[]` once for an unknown or deleted Thread or one of
   * another Project, `[]` while no fence renderer of `tag` is registered in the
   * window, and `[]` when the Thread is deleted. An input that fails
   * `watchFencesInputSchema` is `invalid_input`. Disposing stops the listener;
   * the conversation store's Threads and recency never change because of it.
   */
  watchFences(
    input: {
      readonly projectId: string;
      readonly threadId: string;
      readonly tag: string;
    },
    listener: StreamListener<readonly ChatFence[]>,
    call?: CallArg,
  ): Disposable;
}

export const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

/**
 * The reader at this install: their turns, their prompt and the stack items
 * they add wear this name. The host does not report who is who yet, so it is
 * fixed here, the one place that is replaced the day it does.
 */
export const READER_NAME = 'jao.scheuermann';

export interface ChatLexical {
  /** Accepted until the window's first conversation editor exists; then `frozen`. */
  registerNodes(
    nodes: readonly Klass<LexicalNode>[],
    call?: CallArg,
  ): Disposable;
  registerExtension(extension: AnyLexicalExtension, call?: CallArg): Disposable;
}

export const ChatLexicalV1 = ref<ChatLexical>('chat.lexical/v1');

/** A block as `onBeforeRenderBlockHook` sees it: its data and its actions. */
export const renderBlockSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    promptId: z.string(),
    sequence: z.number(),
    data: z.unknown(),
    actions: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  })
  .strict();

export type RenderBlock = z.output<typeof renderBlockSchema>;

const threadRef = z
  .object({ projectId: z.string(), threadId: z.string() })
  .strict();

export const ChatHooksV1 = defineHooks('chat.hooks/v1', {
  onMountHook: defineHook({ kind: 'observe', input: threadRef }),
  onUnmountHook: defineHook({ kind: 'observe', input: threadRef }),
  onBeforeRenderBlockHook: defineHook({
    kind: 'transform',
    input: renderBlockSchema,
  }),
  /** D9-10: a held conversation saw a sandbox-writing tool or lifecycle change. */
  onSandboxActivityHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string() }).strict(),
  }),
  /**
   * 1.1.0 (R-9.6): every live event of a held Thread as it is received
   * (before the 100 ms flush; never a snapshot or history), and every
   * `updated` record. Chat does not await it.
   */
  onThreadUpdateHook: defineHook({
    kind: 'observe',
    input: z
      .object({
        projectId: z.string(),
        threadId: z.string(),
        threadName: z.string(),
        update: z.custom<ThreadUpdateNotice>(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            ((value as { kind?: unknown }).kind === 'event' ||
              (value as { kind?: unknown }).kind === 'updated'),
          { message: 'Expected an event or an updated record.' },
        ),
      })
      .strict(),
  }),
});

/** What `onThreadUpdateHook` reports for one Thread. */
export type ThreadUpdateNotice =
  | { readonly kind: 'event'; readonly event: ThreadEvent }
  | { readonly kind: 'updated'; readonly thread: Thread };

export interface ThreadUpdateInput {
  readonly projectId: string;
  readonly threadId: string;
  readonly threadName: string;
  readonly update: ThreadUpdateNotice;
}

/**
 * R-9.7: the block type of another Thread's input in this one (a delegated
 * instruction or result). Its renderer's element implements
 * `ChatBlockElement`; without a renderer, chat draws it itself.
 */
export const DELEGATED_INPUT_BLOCK = 'chat.delegated-input/v1';

/** The other Thread's input, as the conversation shows it. */
export interface DelegatedInput {
  readonly kind: 'parent' | 'result';
  readonly threadId: string;
  /** The child's terminal status, when the host recorded one. */
  readonly status?: string;
  /** The sender's own words, with the host's envelope removed. */
  readonly text: string;
}

/** The `block` a delegated-input element receives. */
export interface DelegatedInputBlock {
  readonly type: typeof DELEGATED_INPUT_BLOCK;
  /** The turn's key in the conversation. */
  readonly id: string;
  readonly data: {
    readonly promptId: string;
    readonly input: DelegatedInput;
  };
}

/**
 * The protocol of an element that draws a collapsible block inside the
 * conversation (R-9.7). Chat sets `block` and `focused`, calls `toggle()` for
 * the conversation's toggle key, and reads `chosen` (whether the reader opened
 * it).
 */
export interface ChatBlockElement {
  block: unknown;
  focused: boolean;
  toggle(): void;
  readonly chosen: boolean;
}

// The one DOM intent a card emits; chat runs `commands.execute(command, input)`.
export const CHAT_INTENT_EVENT = 'chat:intent';

export interface ChatIntentDetail {
  readonly command: string;
  readonly input?: unknown;
}

/* chat.composer/v1 ------------------------------------------------------------------ */

// The composer's state lives in the main process, so every window reads the same
// draft and the same comment stack (`docs/architecture/bundles/comments.md`,
// "O rascunho e a pilha do compositor"). The stack's items are generic on
// purpose: the bundle that owns a comment `kind` declares what its item carries
// and how its flush turns the draft into a durable write; the chat only draws
// the line and hands the item back to the flush the owner registered. The
// comment shapes are the `comments` bundle's, imported from `comments/contracts`
// (the `comments` bundle is always enabled alongside this one).

/** One item of the composer's comment stack: a draft until the send flushes it. */
export interface ComposerItem {
  /**
   * The item's identity, assigned when it is added: `comment-<uuid>`. It is
   * also the id of the comment the item becomes — the flush writes it as
   * `commentId`, and a reply names it in `inReplyTo` — so the prompt that
   * carries the draft and the log that records it speak of the same comment.
   */
  readonly id: string;
  /** The kind of comment, declared by the bundle that owns it. */
  readonly kind: string;
  /**
   * The element tag that draws this item's line, resolved as a conversation
   * block's element is; `CHAT_COMMENT_LINE_TAG` names the built-in line.
   */
  readonly elementTag: string;
  /**
   * The owner's payload. Chat reads only the fields `ComposerItemData` names
   * (the target, the pin, the root a reply continues, the target's references)
   * and leaves every other field to the owner.
   */
  readonly data: unknown;
  /**
   * Who wrote the comment; the line's avatar is the initials of this name over
   * a colour derived from it.
   */
  readonly author?: string;
  /** The note as written; the line shows it truncated and the details show it whole. */
  readonly note: string;
}

/** The element tag of the line the chat itself draws for a stack item. */
export const CHAT_COMMENT_LINE_TAG = 'chat-comment-line';

/** The prefix of every stack item id, which is also its comment id. */
export const COMPOSER_ITEM_ID_PREFIX = 'comment-';

/**
 * The part of a stack item's `data` the chat reads, whoever owns the kind: the
 * comment's target (with its anchor), the pin number the owner shows, the
 * comment a reply continues and the target's references for the prompt. The
 * owner may add fields of its own; chat never reads them.
 */
export interface ComposerItemData {
  readonly target: CommentTarget;
  /** The number the owner's surface shows for the comment. */
  readonly pin?: number;
  /** The root comment a reply continues: an item id or a logged comment id. */
  readonly inReplyTo?: string;
  /** What the prompt names the target by. */
  readonly refs?: {
    readonly title?: string;
    readonly source?: string;
  };
}

/**
 * One durable comment write a flush answers: `comments/v1.add`'s input, with
 * the comment id (the item's own id, so the write is idempotent) and the root
 * a reply continues.
 */
export type ComposerCommentWrite = CommentAddInput & {
  readonly commentId?: string;
  readonly inReplyTo?: string;
};

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
      readonly items: ComposerItem[];
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
) => Promise<readonly ComposerCommentWrite[]>;

export interface ComposerReadInput {
  readonly threadId: string;
}

export interface ComposerTextInput {
  readonly threadId: string;
  readonly text: string;
}

export interface ComposerAddInput {
  readonly threadId: string;
  /**
   * The id an item put back on the stack keeps (a flushed comment whose write
   * failed): honoured when it carries the `comment-` prefix and the stack does
   * not hold it yet; otherwise the composer assigns a new one.
   */
  readonly id?: string;
  readonly kind: string;
  readonly elementTag: string;
  readonly data?: unknown;
  readonly author?: string;
  readonly note?: string;
}

export interface ComposerNoteInput {
  readonly threadId: string;
  readonly id: string;
  readonly note: string;
}

export interface ComposerRemoveInput {
  readonly threadId: string;
  readonly id: string;
}

export interface ComposerFlushInput {
  readonly threadId: string;
  readonly promptId: string;
}

/**
 * One item the send took off the stack, with the comment writes its kind's
 * flush answered. The sender performs the writes and, when one of them fails,
 * puts the item back on the stack (`addItem`), so a comment the log never
 * received is not lost with the send.
 */
export interface ComposerFlushed {
  readonly item: ComposerItem;
  readonly writes: readonly ComposerCommentWrite[];
}

export interface ComposerFlushRegistration {
  readonly kind: string;
  readonly flush: ComposerFlush;
}

/**
 * `chat.composer/v1` (desktopMain), cardinality `one`: the draft every window
 * shares. The exposed methods are bridge calls (the stack and the text are
 * plain data); `registerFlush` carries a function, so it only serves callers in
 * the main process — the bundle that owns a kind registers the flush of that
 * kind from its own desktop part.
 */
export interface ChatComposer {
  /** The Thread's portrait: its draft text and its stack, empty until written. */
  read(input: ComposerReadInput, call?: CallArg): Promise<ComposerSnapshot>;
  /** The portrait first, then the deltas — `runtime.threads/v1.watchThread`'s shape. */
  watch(
    threadId: string,
    listener: StreamListener<ComposerWatchItem>,
    call?: CallArg,
  ): Disposable;
  /** Sets the Thread's draft text; every window's watch sees the delta. */
  setText(input: ComposerTextInput, call?: CallArg): Promise<void>;
  /** Adds one item to the Thread's stack and returns it with its identity. */
  addItem(input: ComposerAddInput, call?: CallArg): Promise<ComposerItem>;
  /** Edits the note of one stack item — a draft is free to change. */
  updateNote(input: ComposerNoteInput, call?: CallArg): Promise<void>;
  /** Removes one item from the Thread's stack. */
  removeItem(input: ComposerRemoveInput, call?: CallArg): Promise<void>;
  /**
   * Runs the flush each item's kind registered, takes the flushed items off
   * the stack and answers each with the comment writes the sender performs. A
   * refused send never calls this, so the stack stays where it was.
   */
  flush(
    input: ComposerFlushInput,
    call?: CallArg,
  ): Promise<readonly ComposerFlushed[]>;
  /** The owner of a kind registers how its items flush; a second registration is a conflict. */
  registerFlush(input: ComposerFlushRegistration, call?: CallArg): Disposable;
}

export const ChatComposerV1 = ref<ChatComposer>('chat.composer/v1');

const composerItemSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    elementTag: z.string().min(1),
    data: z.unknown(),
    author: z.string().optional(),
    note: z.string(),
  })
  .strict() satisfies z.ZodType<ComposerItem, ComposerItem>;

const composerWatchItemSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('snapshot'),
      threadId: z.string(),
      text: z.string(),
      items: z.array(composerItemSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      threadId: z.string(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('added'),
      threadId: z.string(),
      item: composerItemSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('updated'),
      threadId: z.string(),
      item: composerItemSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('removed'),
      threadId: z.string(),
      id: z.string(),
    })
    .strict(),
]);

const composerReadSchema = z
  .object({ threadId: z.string().min(1) })
  .strict() satisfies z.ZodType<ComposerReadInput, ComposerReadInput>;

const composerTextSchema = z
  .object({ threadId: z.string().min(1), text: z.string() })
  .strict() satisfies z.ZodType<ComposerTextInput, ComposerTextInput>;

const composerAddInputSchema = z
  .object({
    threadId: z.string().min(1),
    id: z.string().min(1).optional(),
    kind: z.string().min(1),
    elementTag: z.string().min(1),
    data: z.unknown(),
    author: z.string().optional(),
    note: z.string().optional(),
  })
  .strict() satisfies z.ZodType<ComposerAddInput, ComposerAddInput>;

const composerNoteSchema = z
  .object({
    threadId: z.string().min(1),
    id: z.string().min(1),
    note: z.string(),
  })
  .strict() satisfies z.ZodType<ComposerNoteInput, ComposerNoteInput>;

const composerRemoveSchema = z
  .object({ threadId: z.string().min(1), id: z.string().min(1) })
  .strict() satisfies z.ZodType<ComposerRemoveInput, ComposerRemoveInput>;

const composerFlushInputSchema = z
  .object({ threadId: z.string().min(1), promptId: z.string().min(1) })
  .strict() satisfies z.ZodType<ComposerFlushInput, ComposerFlushInput>;

const composerFlushRegistrationSchema = z
  .object({
    kind: z.string().min(1),
    flush: z.custom<ComposerFlush>((value) => typeof value === 'function', {
      message: 'Expected a flush function.',
    }),
  })
  .strict() satisfies z.ZodType<
  ComposerFlushRegistration,
  ComposerFlushRegistration
>;

/**
 * The exposed methods of `chat.composer/v1`. `registerFlush` carries a function
 * and is not exposed to the desktop: the desktop bridge refuses it and the
 * main process is where a kind's owner registers its flush.
 */
export const chatComposerMethods = {
  read: {
    input: composerReadSchema,
    output: z
      .object({
        threadId: z.string(),
        text: z.string(),
        items: z.array(composerItemSchema),
      })
      .strict(),
    expose: 'desktop',
  },
  watch: {
    input: z.tuple([
      z.string().min(1),
      streamListener(composerWatchItemSchema),
    ]),
    output: disposableSchema,
    expose: 'desktop',
  },
  setText: { input: composerTextSchema, output: z.void(), expose: 'desktop' },
  addItem: {
    input: composerAddInputSchema,
    output: composerItemSchema,
    expose: 'desktop',
  },
  updateNote: {
    input: composerNoteSchema,
    output: z.void(),
    expose: 'desktop',
  },
  removeItem: {
    input: composerRemoveSchema,
    output: z.void(),
    expose: 'desktop',
  },
  flush: {
    input: composerFlushInputSchema,
    output: z.array(
      z
        .object({
          item: composerItemSchema,
          writes: z.array(commentAddInputSchema),
        })
        .strict(),
    ),
    expose: 'desktop',
  },
  registerFlush: {
    input: composerFlushRegistrationSchema,
    output: disposableSchema,
  },
} as const satisfies MethodSpecs;

/* chat.send/v1 ---------------------------------------------------------------- */

/** Which Thread's stack a send carries, and the Project it belongs to. */
export interface ChatSendInput {
  readonly projectId: string;
  readonly threadId: string;
}

/**
 * What a send answered: the host accepted the prompt (the stack was flushed
 * into the log and the draft text cleared), the draft carried no words to
 * send, or the host refused the prompt — the draft then stays where it was.
 */
export interface ChatSendResult {
  readonly status: 'accepted' | 'empty' | 'refused';
}

/**
 * 1.1.0 (conversation-openui.md D20): one click on a control of a UI the agent
 * drew, sent as the reader's next message of the Thread.
 */
export interface ChatActionInput {
  readonly projectId: string;
  readonly threadId: string;
  /** The program identity (openui.md D3): a written identity or an anonymous `_<n>`. */
  readonly program: string;
  /** The action's text: not blank, at most 16,000 UTF-16 code units; sent unchanged. */
  readonly text: string;
}

/**
 * `accepted`: the Thread took the message (steered into the running prompt,
 * queued, or a new prompt). `refused`: it did not, and nothing was sent.
 */
export interface ChatActionResult {
  readonly status: 'accepted' | 'refused';
}

/**
 * `chat.send/v1` (client, one per window): sends a Thread's held draft now —
 * the same send the composer's control makes, read from `chat.composer/v1`:
 * the stack's comments and the draft text become the prompt envelope
 * (`<comments>` then `<message>`), the host is asked through
 * `runtime.threads/v1.prompt`, and only after it accepts does the stack flush
 * into `comments.added/v1` (an item whose write fails goes back on the stack)
 * and the draft text clear in every window. A surface outside the composer —
 * the papercraft canvas, in the conversation or in its own window — sends with
 * it (`Cmd+Enter`).
 *
 * It is a client contract, not a `chat.composer/v1` method, because the send
 * reaches the host (`runtime.threads/v1`, `comments/v1`) and the composer runs
 * in the main process, which does not call the host's contracts.
 */
export interface ChatSend {
  send(input: ChatSendInput, call?: CallArg): Promise<ChatSendResult>;
  /**
   * 1.1.0. Sends `text`, wrapped in a `<ui-action program="…">` envelope, by
   * the composer's route for a typed message: a steer of the Thread's running
   * prompt, else a new prompt (resuming a paused, empty queue first).
   *
   * Answers `refused`, with nothing sent or resumed, for a Thread that is
   * unknown, of another Project or an agent's (`origin: 'agent'`), and when
   * the route was not taken. An input that fails `chatSendMethods.sendAction`'s
   * schema rejects with `invalid_input`. It never touches the composer: the
   * draft, the stack and the store's pending turn stay as they were.
   */
  sendAction(input: ChatActionInput, call?: CallArg): Promise<ChatActionResult>;
}

export const ChatSendV1 = ref<ChatSend>('chat.send/v1');

export const chatSendMethods = {
  send: {
    input: z
      .object({ projectId: z.string().min(1), threadId: z.string().min(1) })
      .strict() satisfies z.ZodType<ChatSendInput, ChatSendInput>,
    output: z
      .object({ status: z.enum(['accepted', 'empty', 'refused']) })
      .strict() satisfies z.ZodType<ChatSendResult, ChatSendResult>,
  },
  sendAction: {
    input: z
      .object({
        projectId: z.string().min(1),
        threadId: z.string().min(1),
        program: z
          .string()
          .regex(/^(?:[a-z][a-z0-9-]{0,63}|_[1-9][0-9]{0,8})$/),
        text: z
          .string()
          .max(16_000)
          .refine((text) => text.trim().length > 0, {
            message: 'Must not be blank.',
          }),
      })
      .strict() satisfies z.ZodType<ChatActionInput, ChatActionInput>,
    output: z
      .object({ status: z.enum(['accepted', 'refused']) })
      .strict() satisfies z.ZodType<ChatActionResult, ChatActionResult>,
  },
} as const satisfies MethodSpecs;

/**
 * The structural shape of a comment target as the line's anchor label reads it;
 * the `comments` bundle owns the real schema, and the line never looks deeper
 * than the anchor's own fields.
 */
export type { CommentTarget };

/** A comment of the log, as the user turn draws it above the reader's words. */
export interface TurnComment {
  readonly commentId: string;
  readonly target: unknown;
  readonly text: string;
  readonly author?: string;
  /** The root comment this one answers; absent on a root comment. */
  readonly inReplyTo?: string;
}

/** The `comments.added/v1` event type, as the log carries it. */
export const COMMENTS_ADDED_EVENT = 'comments.added/v1';

/** The `comments.resolved/v1` event type: a root comment resolved or reopened. */
export const COMMENTS_RESOLVED_EVENT = 'comments.resolved/v1';

/**
 * The DOM event the conversation dispatches when the reader asks to open one
 * comment's thread — a sent comment's line in a user turn, or the state glyph
 * of an agent's reply row. It bubbles (and crosses shadow roots) from the
 * element that was clicked; the bundle that draws the comment's target
 * (Papercraft's pins) listens for it and opens the thread.
 */
export const COMMENT_THREAD_OPEN_EVENT = 'doric:comment-thread-open';

/**
 * The client command the window's `CmdOrCtrl+Enter` dispatches on the
 * conversation's route, the chord's one owner there: the composer's send —
 * the one its control makes — for the Thread whose conversation holds the
 * focus, else the Thread the route names. It sends the words, the stack or
 * both, and steers a running prompt, wherever the focus is in the window.
 */
export const SEND_PROMPT_COMMAND = 'chat.send-prompt/v1';

/**
 * The DOM event `SEND_PROMPT_COMMAND` dispatches on the document before it
 * reads the stack: a surface holding a note the reader has not confirmed yet
 * (Papercraft's open comment input) confirms it and hands the confirmation to
 * `waitUntil`, and the send waits for it, so the note goes with the prompt.
 */
export const PROMPT_SEND_EVENT = 'doric:prompt-send';

/** The detail of `PROMPT_SEND_EVENT`. */
export interface PromptSendDetail {
  /** The Thread about to send. */
  readonly threadId: string;
  /** Holds the send until `pending` settles. */
  waitUntil(pending: Promise<unknown>): void;
}

/** The detail of `COMMENT_THREAD_OPEN_EVENT`. */
export interface CommentThreadOpenDetail {
  /** The thread's root comment id. */
  readonly commentId: string;
  /**
   * The root comment's target, as `comments.added/v1` carried it. A target
   * without `revision` names the latest revision: only the target's latest
   * drawing answers it. The conversation sends it without one, so the thread
   * opens on the latest preview of the target.
   */
  readonly target: unknown;
}

/**
 * The comment kind this bundle owns: a comment on one of the agent's messages,
 * anchored to the range the reader selected in it. The selection gesture in
 * the conversation (`comment-selection.tsx`) writes the target into the
 * stack item's `data` as `{ target: CommentTarget }`, and the flush this
 * bundle registers (`src/desktop/message-flush.ts`) reads it back.
 */
export const MESSAGE_KIND = 'message';

/** Reads one `comments.added/v1` payload as a turn comment, else `undefined`. */
export const turnCommentFrom = (payload: unknown): TurnComment | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const commentId = record.commentId;
  const target = record.target;
  const text = record.text;

  if (
    typeof commentId !== 'string' ||
    commentId.length === 0 ||
    target === undefined ||
    typeof text !== 'string'
  ) {
    return undefined;
  }

  return {
    commentId,
    target,
    text,
    ...(typeof record.author === 'string' ? { author: record.author } : {}),
    ...(typeof record.inReplyTo === 'string' && record.inReplyTo.length > 0
      ? { inReplyTo: record.inReplyTo }
      : {}),
  };
};
