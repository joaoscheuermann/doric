import type {
  ProviderId,
  ProviderMessage,
  ProviderRequest,
} from '../../types/provider.js';
import {
  isStrictCompatible,
  messagesWithStructuredSchema,
  messageText,
  requireRequestInput,
  structuredJsonSchema,
} from '../common.js';

const structuredOutputName = 'structured_output';

export type OpenRouterBodyOptions = {
  readonly structuredOutput?: 'json_schema' | 'json_object' | 'prompt';
  readonly requireParameters?: boolean;
  readonly replay?: 'all' | 'tool_calls';
  readonly strictTools?: boolean;
  readonly providerId?: ProviderId;
};

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
    messages: messages.map((message) =>
      prune({
        role: message.role,
        content: messageText(message),
        reasoning_details: replayItems(message, options.replay ?? 'all'),
        tool_call_id: message.toolCallId,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
        name: message.name,
      }),
    ),
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

  if (value === undefined || value === false) {
    return request.effort === undefined
      ? undefined
      : { effort: request.effort };
  }

  return value === true
    ? request.effort === undefined
      ? {}
      : { effort: request.effort }
    : prune({ effort: request.effort ?? value.effort, summary: value.summary });
};

const prune = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
