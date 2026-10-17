// The artifacts client's view of chat's `chat.views/v1` and the block
// vocabulary, kept as a structural copy so this bundle does not import the
// `chat` package (the `papercraft` client does the same): the IDs and shapes
// are chat's, as `docs/architecture/bundles/events-and-nodes.md` states them.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

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
