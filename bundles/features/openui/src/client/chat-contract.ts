// The openui client's view of chat's `chat.views/v1` 1.1.0 and `chat.send/v1`
// 1.1.0 (openui.md D1, conversation-openui.md D20): a structural copy of what
// it uses, as `threads` keeps its own; the IDs and the shapes are chat's. Both
// the entry and the renderer chunk bundle it; it holds types and refs only,
// matched by contract ID, so two copies behave as one.

import {
  type CallArg,
  type Disposable,
  defineHook,
  defineHooks,
  ref,
  type StreamListener,
} from 'bundle/contracts';
import { z } from 'zod';

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

/** A projector of event types the built-in projection does not claim (chat's `ProjectorSpec`). */
export interface ProjectorSpec<S = unknown> {
  readonly eventTypes: readonly string[];
  initial(): S;
  reduce(
    state: S,
    event: ChatThreadEvent,
  ): { readonly state: S; readonly blocks: readonly ChatBlock[] };
}

/** One fence of an agent turn (chat's `ChatFence`). */
export interface ChatFence {
  /** `${promptId}/${turnSequence}/${index}`. */
  readonly key: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly turnSequence: number;
  readonly index: number;
  readonly info: string;
  readonly body: string;
  readonly state: 'streaming' | 'closed' | 'unterminated';
}

/** The `view` property the chat sets on the element (chat's `ChatFenceView`). */
export interface ChatFenceView {
  readonly fence: ChatFence;
  readonly origin: 'user' | 'agent';
  readonly fences: readonly ChatFence[];
}

export interface ChatViews {
  /** `registration_conflict` when a type is already claimed. */
  registerProjector(spec: ProjectorSpec, call?: CallArg): Disposable;
  /** `registration_conflict` for a tag already registered; `invalid_input` for an undefined element. */
  registerFenceRenderer(
    spec: { readonly tag: string; readonly elementTag: string },
    call?: CallArg,
  ): Disposable;
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

/** Chat's `ChatActionInput`. */
export interface ChatActionInput {
  readonly projectId: string;
  readonly threadId: string;
  readonly program: string;
  readonly text: string;
}

/** Chat's `ChatActionResult`. */
export interface ChatActionResult {
  readonly status: 'accepted' | 'refused';
}

export interface ChatSend {
  /** `refused` when the Thread did not take the message; rejects with `invalid_input` for a bad input. */
  sendAction(input: ChatActionInput, call?: CallArg): Promise<ChatActionResult>;
}

export const ChatSendV1 = ref<ChatSend>('chat.send/v1');

/**
 * A structural copy of the one `chat.hooks/v1` hook the client registers
 * (`onThreadUpdateHook`, 1.1.0), matched by contract ID only and reached with
 * `HooksV1.whenAvailable`. Chat calls it with every live event of a held
 * Thread as it arrives and with every `updated` record, and never awaits it.
 */
export const ChatHooksV1 = defineHooks('chat.hooks/v1', {
  onThreadUpdateHook: defineHook({
    kind: 'observe',
    input: z.object({
      projectId: z.string(),
      threadId: z.string(),
      threadName: z.string(),
      update: z.custom<
        | { readonly kind: 'event'; readonly event: ChatThreadEvent }
        | { readonly kind: 'updated'; readonly thread: unknown }
      >(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'kind' in value &&
          (value.kind === 'event' || value.kind === 'updated'),
      ),
    }),
  }),
});

/** What `onThreadUpdateHook` hands its handler. */
export type ThreadUpdateInput = z.output<
  (typeof ChatHooksV1)['hooks']['onThreadUpdateHook']['input']
>;
