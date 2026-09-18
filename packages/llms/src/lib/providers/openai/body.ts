import type {
  JsonObject,
  ProviderMessage,
  ProviderRequest,
  ProviderToolCall,
} from '../../types/provider.js';
import {
  isStrictCompatible,
  messagesWithStructuredSchema,
  messageText,
  requireRequestInput,
  structuredJsonSchema,
} from '../common.js';

const structuredOutputName = 'structured_output';

export const openAiBody = (
  request: ProviderRequest<unknown>,
  stream: boolean,
  provider = 'openai',
): Record<string, unknown> => {
  requireRequestInput(provider, request);

  const schema = structuredJsonSchema(provider, request.schema);
  const messages = messagesWithStructuredSchema(provider, request, schema);
  const alias = fastAlias(request.model);

  const system = messages
    .filter((message) => message.role === 'system')
    .map(messageText)
    .filter((text) => text !== '')
    .join('\n\n');
  const nonSystem = messages.filter((message) => message.role !== 'system');

  return prune({
    model: alias.model,
    instructions: system === '' ? undefined : system,
    input: nonSystem.flatMap(inputItems),
    tools: request.tools?.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: tool.strict === true && isStrictCompatible(tool.inputSchema),
    })),
    tool_choice: toolChoice(request.toolChoice),
    parallel_tool_calls: request.parallelToolCalls,
    text:
      schema === undefined
        ? undefined
        : {
            format: prune({
              type: 'json_schema',
              name: structuredOutputName,
              strict: isStrictCompatible(schema),
              schema,
            }),
          },
    temperature: request.temperature,
    max_output_tokens: request.maxOutputTokens,
    service_tier: request.flags?.serviceTier ?? alias.serviceTier,
    reasoning: reasoningRequest(request),
    store: false,
    stream,
  });
};

const inputItems = (
  message: ProviderMessage,
): readonly Record<string, unknown>[] => {
  if (message.role === 'tool') {
    return [
      prune({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: messageText(message),
        status: message.toolResultStatus,
      }),
    ];
  }

  const text = messageText(message);

  if (message.role === 'assistant') {
    if (message.replay !== undefined && message.replay.length > 0) {
      return message.replay;
    }

    return message.toolCalls?.map(functionCallItem) ?? [];
  }

  const item = {
    role: message.role,
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };

  return [item];
};

const functionCallItem = (call: ProviderToolCall): Record<string, unknown> => ({
  type: 'function_call',
  call_id: call.id,
  name: call.name,
  arguments: call.arguments,
});

const fastAlias = (
  model: string,
): { readonly model: string; readonly serviceTier?: 'priority' } =>
  model.endsWith('-fast')
    ? { model: model.slice(0, -5), serviceTier: 'priority' }
    : { model };

const reasoningRequest = (
  request: ProviderRequest<unknown>,
): JsonObject | undefined => {
  const value = request.flags?.reasoning;

  if (value === undefined || value === false) {
    return request.effort === undefined
      ? undefined
      : { effort: request.effort };
  }

  if (value === true) {
    return request.effort === undefined ? {} : { effort: request.effort };
  }

  return prune({
    effort: request.effort ?? value.effort,
    summary: value.summary,
  }) as JsonObject;
};

const toolChoice = (
  choice: ProviderRequest<unknown>['toolChoice'],
): string | Record<string, string> | undefined =>
  typeof choice === 'object' ? { type: 'function', name: choice.name } : choice;

const prune = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
