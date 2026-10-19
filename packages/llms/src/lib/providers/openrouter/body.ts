import type {
  ProviderId,
  ProviderImagePart,
  ProviderMessage,
  ProviderRequest,
} from '../../types/provider.js';
import {
  messageImages,
  messageText,
  requestReasoningEffort,
  requireRequestInput,
} from '../common.js';
import {
  isStrictCompatible,
  messagesWithStructuredSchema,
  structuredJsonSchema,
} from '../structured.js';

const structuredOutputName = 'structured_output';

export interface OpenRouterBodyOptions {
  readonly structuredOutput?: 'json_schema' | 'json_object' | 'prompt';
  readonly requireParameters?: boolean;
  readonly replay?: 'all' | 'tool_calls';
  readonly strictTools?: boolean;
  readonly providerId?: ProviderId;
}

export const openRouterBody = (
  request: ProviderRequest<unknown>,
  stream: boolean,
  options: OpenRouterBodyOptions = {},
): Record<string, unknown> => {
  const providerId = options.providerId ?? 'openrouter';
  requireRequestInput(providerId, request);
  const schema = structuredJsonSchema(providerId, request.schema);
  const structuredOutput = options.structuredOutput ?? 'json_schema';
  const messages = messagesWithStructuredSchema(
    providerId,
    structuredOutput === 'json_schema' || request.schema === undefined
      ? request
      : {
          ...request,
          flags: {
            ...request.flags,
            includeStructuredSchemaOnSystemPrompt: true,
          },
        },
    schema,
  );

  return prune({
    model: request.model,
    messages: chatMessages(messages, options.replay ?? 'all'),
    tools: request.tools?.map((tool) => ({
      type: 'function',
      function: prune({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict:
          options.strictTools === false
            ? undefined
            : tool.strict === true && isStrictCompatible(tool.inputSchema),
      }),
    })),
    tool_choice: toolChoice(request.toolChoice),
    parallel_tool_calls: request.parallelToolCalls,
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    reasoning: reasoningRequest(request),
    response_format: responseFormat(structuredOutput, schema),
    provider: options.requireParameters
      ? { require_parameters: true }
      : undefined,
    stream,
    stream_options:
      request.flags?.includeUsage === false
        ? undefined
        : { include_usage: true },
  });
};

/**
 * The history as Chat Completions messages. A user turn's images travel as
 * `image_url` parts beside its text. A tool message carries text alone on most
 * models, so the images tool results returned follow the run of tool messages
 * they belong to as one user message, each set introduced by the call that
 * returned it: that keeps every tool message right after its assistant turn.
 */
const chatMessages = (
  messages: readonly ProviderMessage[],
  replay: NonNullable<OpenRouterBodyOptions['replay']>,
): readonly Record<string, unknown>[] => {
  const result: Record<string, unknown>[] = [];
  let returned: Record<string, unknown>[] = [];
  const flush = () => {
    if (returned.length === 0) return;
    result.push({ role: 'user', content: returned });
    returned = [];
  };

  for (const message of messages) {
    if (message.role !== 'tool') flush();
    result.push(chatMessage(message, replay));
    const images = message.role === 'tool' ? messageImages(message) : [];
    if (images.length > 0) {
      returned.push(
        {
          type: 'text',
          text: `The tool call \`${message.toolCallId ?? ''}\` returned these images:`,
        },
        ...images.map(imagePart),
      );
    }
  }
  flush();

  return result;
};

const chatMessage = (
  message: ProviderMessage,
  replay: NonNullable<OpenRouterBodyOptions['replay']>,
): Record<string, unknown> =>
  prune({
    role: message.role,
    content: chatContent(message),
    reasoning_details: replayItems(message, replay),
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
    name: message.name,
  });

/** A user turn with images as parts in order; every other message as text. */
const chatContent = (
  message: ProviderMessage,
): string | readonly Record<string, unknown>[] =>
  message.role !== 'user' ||
  typeof message.content === 'string' ||
  messageImages(message).length === 0
    ? messageText(message)
    : (message.content ?? []).map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : imagePart(part),
      );

const imagePart = (part: ProviderImagePart): Record<string, unknown> => ({
  type: 'image_url',
  image_url: { url: part.imageUrl },
});

const replayItems = (
  message: ProviderMessage,
  policy: NonNullable<OpenRouterBodyOptions['replay']>,
) =>
  message.replay === undefined ||
  (policy === 'tool_calls' && (message.toolCalls?.length ?? 0) === 0)
    ? undefined
    : message.replay;

const toolChoice = (
  choice: ProviderRequest<unknown>['toolChoice'],
): string | Record<string, unknown> | undefined =>
  typeof choice === 'object'
    ? { type: 'function', function: { name: choice.name } }
    : choice;

const responseFormat = (
  strategy: NonNullable<OpenRouterBodyOptions['structuredOutput']>,
  schema: ReturnType<typeof structuredJsonSchema>,
): Record<string, unknown> | undefined => {
  if (schema === undefined || strategy === 'prompt') {
    return undefined;
  }

  if (strategy === 'json_object') {
    return { type: 'json_object' };
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: structuredOutputName,
      strict: isStrictCompatible(schema),
      schema,
    },
  };
};

const reasoningRequest = (
  request: ProviderRequest<unknown>,
): Record<string, unknown> | undefined => {
  const value = request.flags?.reasoning;
  const effort = requestReasoningEffort(request);

  if (effort === undefined && (value === undefined || value === false)) {
    return undefined;
  }

  return prune({
    effort,
    summary: typeof value === 'object' ? value.summary : undefined,
  });
};

const prune = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
