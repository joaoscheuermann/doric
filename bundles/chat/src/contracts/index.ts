// Public contracts of the `chat` bundle (stage 9, §7.2). They are typed
// references and schemas only; the providers live in the client part.

import {
  type CallArg,
  type Disposable,
  defineHook,
  defineHooks,
  ref,
} from 'bundle/contracts';
import type { AnyLexicalExtension, Klass, LexicalNode } from 'lexical';
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

export interface ChatViews {
  registerProjector(spec: ProjectorSpec, call?: CallArg): Disposable;
  registerRenderer(spec: RendererSpec, call?: CallArg): Disposable;
}

export const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

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
});

/** The one DOM intent a card emits; chat runs `commands.execute(command, input)`. */
export const CHAT_INTENT_EVENT = 'chat:intent';

export interface ChatIntentDetail {
  readonly command: string;
  readonly input?: unknown;
}
