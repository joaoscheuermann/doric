import type {
  ProviderImagePart,
  ProviderMessage,
  ProviderReplayItem,
  ProviderRequest,
} from '../../types/provider.js';
import {
  messageImages,
  messageText,
  requestReasoningEffort,
  requireRequestInput,
} from '../common.js';
import {
  messagesWithStructuredSchema,
  structuredJsonSchema,
} from '../structured.js';
import {
  claudeEffort,
  rejectsForcedToolChoice,
  thinksByDefault,
} from './models.js';

/**
 * The system line every Claude Code request opens with: a subscription login
 * is accepted only when the first system block is this identity, so the
 * caller's own system text follows it rather than replacing it.
 */
export const claudeDefaultInstructions =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * The user turn a history that ends on a final assistant answer gets, because
 * a request whose last message is the assistant's is a prefill, which every
 * current model refuses.
 */
export const claudeContinuation =
  'Continue from where your previous response ended.';

/** The beta a request needs to set `thinking.block_binding`. */
export const claudeThinkingBindingBeta = 'thinking-binding-controls-2026-08-01';

/**
 * The default output cap; Anthropic requires one. A stream has room for a
 * long thinking turn, while a plain request stays under the HTTP timeouts.
 */
const DEFAULT_STREAM_MAX_TOKENS = 64000;
const DEFAULT_MAX_TOKENS = 16000;

/** The prompt-cache marker: Anthropic's five-minute ephemeral cache. */
const ephemeral = { type: 'ephemeral' } as const;

/** The provider tag Claude's replay items carry, so no other provider replays them. */
export const claudeReplayProvider = 'claude';

/**
 * A request as an Anthropic Messages body: the Claude Code identity and then
 * the caller's system lines as `system` blocks, history as Messages messages
 * (with Claude's own replayed thinking), tool results as `tool_result`
 * blocks, the requested effort where the model takes one, and prompt-cache
 * markers on the system prompt and the growing tail. `temperature` is never
 * sent: current models refuse any value but the default. Structured output
 * travels as a schema prompt when the flag asks for it.
 */
export const claudeBody = (
  request: ProviderRequest<unknown>,
  stream: boolean,
  provider = 'claude',
): Record<string, unknown> => {
  requireRequestInput(provider, request);
  const schema = structuredJsonSchema(provider, request.schema);
  const messages = messagesWithStructuredSchema(provider, request, schema);
  const system = messages
    .filter((message) => message.role === 'system')
    .map(messageText)
    .filter((text) => text !== '')
    .join('\n\n');
  const nonSystem = messages.filter((message) => message.role !== 'system');
  const effort = claudeEffort(request.model, requestReasoningEffort(request));
  const systemBlocks = [
    { type: 'text', text: claudeDefaultInstructions },
    ...(system === '' ? [] : [{ type: 'text', text: system }]),
  ];

  return prune({
    model: request.model,
    // The last system block caches the tools and system prompt before it;
    // the top-level marker caches the conversation up to its last block.
    system: systemBlocks.map((block, index) =>
      index === systemBlocks.length - 1
        ? { ...block, cache_control: ephemeral }
        : block,
    ),
    messages: claudeMessages(nonSystem),
    tools: request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
    tool_choice:
      request.tools === undefined || request.tools.length === 0
        ? undefined
        : toolChoice(
            request.toolChoice,
            request.parallelToolCalls,
            rejectsForcedToolChoice(request.model),
          ),
    // Only models that think by default get a `thinking` field: it keeps
    // thinking where it already is and lets a rewritten history (compaction)
    // drop the blocks it invalidated instead of refusing the request.
    thinking: thinksByDefault(request.model)
      ? {
          type: 'adaptive',
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        }
      : undefined,
    output_config: effort === undefined ? undefined : { effort },
    max_tokens:
      request.maxOutputTokens ??
      (stream ? DEFAULT_STREAM_MAX_TOKENS : DEFAULT_MAX_TOKENS),
    cache_control: ephemeral,
    stream,
  });
};

/** The `anthropic-beta` values a body needs beyond the OAuth ones. */
export const claudeBodyBetas = (
  body: Record<string, unknown>,
): readonly string[] =>
  body.thinking === undefined ? [] : [claudeThinkingBindingBeta];

/**
 * The history as Messages messages. A run of tool messages becomes one user
 * message of `tool_result` blocks, because Anthropic accepts tool results
 * only as user content. A message with no content left (an empty assistant
 * turn) is dropped, turns of one role side by side become one, and a history
 * that ends on an assistant answer gets a continuation turn, since a final
 * assistant message is a prefill.
 */
const claudeMessages = (
  messages: readonly ProviderMessage[],
): readonly Record<string, unknown>[] => {
  const result: {
    readonly role: 'user' | 'assistant';
    content: Record<string, unknown>[];
  }[] = [];

  const push = (
    role: 'user' | 'assistant',
    content: readonly Record<string, unknown>[],
  ): void => {
    if (content.length === 0) return;
    const last = result.at(-1);
    if (last?.role === role) {
      last.content.push(...content);
      return;
    }
    result.push({ role, content: [...content] });
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      push('user', [toolResult(message)]);
    } else if (message.role === 'assistant') {
      push('assistant', assistantContent(message));
    } else {
      push('user', userContent(message));
    }
  }

  // A final turn that calls tools waits on their results instead.
  const last = result.at(-1);
  if (
    last?.role === 'assistant' &&
    !last.content.some((block) => block.type === 'tool_use')
  ) {
    push('user', [{ type: 'text', text: claudeContinuation }]);
  }

  return result;
};

/**
 * A tool message as a `tool_result` block: its text, and its images after it
 * in order. A `tool_result` takes no status: an incomplete result (an
 * interrupted or repaired call) is the error flag Anthropic does accept.
 */
const toolResult = (message: ProviderMessage): Record<string, unknown> => ({
  type: 'tool_result',
  tool_use_id: message.toolCallId ?? '',
  content:
    messageImages(message).length === 0
      ? messageText(message)
      : userContent(message),
  ...(message.toolResultStatus === 'incomplete' ? { is_error: true } : {}),
});

/** A user message as content blocks, text parts and image sources in order; no empty text. */
const userContent = (
  message: ProviderMessage,
): readonly Record<string, unknown>[] => {
  if (
    typeof message.content === 'string' ||
    message.content === undefined ||
    messageImages(message).length === 0
  ) {
    const text = messageText(message);

    return text === '' ? [] : [{ type: 'text', text }];
  }

  return (message.content ?? []).flatMap<Record<string, unknown>>((part) =>
    part.type === 'text'
      ? part.text === ''
        ? []
        : [{ type: 'text', text: part.text }]
      : [{ type: 'image', source: imageSource(part) }],
  );
};

/**
 * An assistant message as Messages content. A turn Claude answered carries
 * its content blocks as replay; when they still name the same tool calls,
 * they go back byte-for-byte, thinking and signatures included, because a
 * thinking block is only valid unchanged. Otherwise the turn is its own
 * thinking blocks, then its text, then its `tool_use` blocks.
 */
const assistantContent = (
  message: ProviderMessage,
): readonly Record<string, unknown>[] => {
  const replayed = claudeReplayBlocks(message.replay);
  const calls = message.toolCalls ?? [];
  const replayedCalls = replayed.filter((block) => block.type === 'tool_use');

  if (
    replayed.length > 0 &&
    replayedCalls.length === calls.length &&
    replayedCalls.every((block, index) => block.id === calls[index]?.id)
  ) {
    return replayed;
  }

  const text = messageText(message);
  const blocks: Record<string, unknown>[] = [
    ...replayed.filter(
      (block) =>
        block.type === 'thinking' || block.type === 'redacted_thinking',
    ),
    ...(text !== '' ? [{ type: 'text', text }] : []),
  ];

  for (const call of calls) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: toolInput(call.arguments),
    });
  }

  return blocks;
};

/** The content blocks Claude's own replay items carry; another provider's are ignored. */
const claudeReplayBlocks = (
  replay: readonly ProviderReplayItem[] | undefined,
): readonly Record<string, unknown>[] =>
  (replay ?? []).flatMap((item) => {
    const block = item.block;
    return item.provider === claudeReplayProvider &&
      block !== null &&
      typeof block === 'object' &&
      !Array.isArray(block)
      ? [block as Record<string, unknown>]
      : [];
  });

/** The arguments a `tool_use` block sends, as the object the call's string parsed to. */
const toolInput = (arguments_: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(arguments_) as unknown;

    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** An image part as an Anthropic source: inline base64 data, or a URL the API fetches. */
const imageSource = (part: ProviderImagePart): Record<string, unknown> => {
  const url = part.imageUrl;
  const marker = ';base64,';

  if (url.startsWith('data:')) {
    const separator = url.indexOf(marker);

    if (separator !== -1) {
      return {
        type: 'base64',
        media_type: url.slice('data:'.length, separator),
        data: url.slice(separator + marker.length),
      };
    }
  }

  return { type: 'url', url };
};

/**
 * A provider tool choice as Anthropic's object form: `required` is spelled
 * `any`, a tool is named, and parallel calls turned off ride along (Anthropic
 * takes that flag on the choice; `none` has no calls to keep apart). A model
 * that refuses forced tool use (Opus 5.5, Sonnet 5.5, Fable 5.1) gets `auto`
 * instead of `any` or a named tool.
 */
const toolChoice = (
  choice: ProviderRequest<unknown>['toolChoice'],
  parallelToolCalls: boolean | undefined,
  forcedRefused: boolean,
): Record<string, unknown> | undefined => {
  const sequential = parallelToolCalls === false;

  if (choice === undefined && !sequential) return undefined;

  const forced = typeof choice === 'object' || choice === 'required';
  const type =
    choice === undefined || (forced && forcedRefused)
      ? 'auto'
      : typeof choice === 'object'
        ? 'tool'
        : choice === 'required'
          ? 'any'
          : choice;

  return {
    type,
    ...(type === 'tool' && typeof choice === 'object'
      ? { name: choice.name }
      : {}),
    ...(sequential && type !== 'none'
      ? { disable_parallel_tool_use: true }
      : {}),
  };
};

const prune = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
