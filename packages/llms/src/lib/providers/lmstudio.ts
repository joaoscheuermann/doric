import type { Logger } from 'pino';

import { ProviderErrorObject } from '../classes/provider-error.js';
import type { HttpTransport } from '../types/http.js';
import type {
  JsonValue,
  LlmProvider,
  Model,
  ProviderCapabilities,
  ProviderEmbeddingFinished,
  ProviderEmbeddingRequest,
  ProviderFinished,
  ProviderMessage,
  ProviderMetadata,
  ProviderRequest,
  ProviderRerankRequest,
  ProviderRerankFinished,
  ProviderStructuredFinished,
  ProviderStreamEvent,
  StructuredOutputSchema,
  StructuredOutputValue,
  UsageMetadata,
} from '../types/provider.js';
import {
  arrayField,
  asRecord,
  numberField,
  recordField,
  stringField,
} from '../utils/json.js';
import { parseSseEvents } from '../utils/sse.js';
import {
  httpError,
  messagesWithStructuredSchema,
  messageText,
  parseJsonBody,
  parseStructuredOutput,
  requestReasoningEffort,
  requireRequestInput,
  streamErrorEvent,
} from './common.js';
import { withProviderLogging } from './logging.js';

type SecretSource = string | (() => string | Promise<string>);

export type LmStudioProviderDeps = {
  readonly transport: HttpTransport;
  readonly apiKey?: SecretSource;
  readonly authorization?: SecretSource;
  readonly baseUrl?: string;
  readonly logger: Logger;
};

export const lmStudioMetadata: ProviderMetadata = {
  id: 'lmstudio',
  name: 'LM Studio',
  baseUrl: 'http://localhost:1234',
};

export const lmStudioCapabilities: ProviderCapabilities = {
  streaming: true,
  embeddings: false,
  reranking: false,
  tools: false,
  reasoning: true,
  modelListing: true,
  oauth: false,
  serviceTier: false,
  structuredOutputs: false,
};

export const createLmStudioProvider = (
  deps: LmStudioProviderDeps,
): LlmProvider => {
  const baseUrl = deps.baseUrl ?? lmStudioMetadata.baseUrl;

  async function complete<Schema extends StructuredOutputSchema>(
    request: ProviderRequest<StructuredOutputValue<Schema>, Schema> & {
      readonly schema: Schema;
    },
  ): Promise<ProviderStructuredFinished<StructuredOutputValue<Schema>>>;
  async function complete<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderFinished<Output>>;
  async function complete<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderFinished<Output>> {
    requireRequestInput('lmstudio', request);
    const sensitiveOutput = request.flags?.sensitiveOutput === true;
    const response = await deps.transport.request({
      method: 'POST',
      url: `${baseUrl}/api/v1/chat`,
      headers: {
        ...(await authHeader(deps)),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(chatBody(request, false)),
      signal: request.signal,
    });

    if (response.status >= 400) {
      throw httpError(
        'lmstudio',
        response.status,
        response.body,
        sensitiveOutput,
      );
    }

    return parseStructuredOutput(
      'lmstudio',
      request,
      finished(
        parseJsonBody('lmstudio', response.body, sensitiveOutput),
        'stop',
      ),
    );
  }

  return withProviderLogging(
    {
      metadata: lmStudioMetadata,
      capabilities: lmStudioCapabilities,

      complete,

      async *stream<Output = JsonValue>(
        request: ProviderRequest<Output>,
      ): AsyncIterable<ProviderStreamEvent<Output>> {
        requireRequestInput('lmstudio', request);
        const sensitiveOutput = request.flags?.sensitiveOutput === true;
        const text: string[] = [];
        const reasoning: string[] = [];
        const auth = await authHeader(deps);

        yield {
          type: 'response.started',
          provider: 'lmstudio',
          model: request.model,
        };

        for await (const event of parseSseEvents(
          deps.transport.stream({
            method: 'POST',
            url: `${baseUrl}/api/v1/chat`,
            headers: {
              ...auth,
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body: JSON.stringify(chatBody(request, true)),
            signal: request.signal,
          }),
        )) {
          if (event.done) {
            break;
          }

          if (event.event === 'chat.start' || event.event === undefined) {
            continue;
          }

          const payload = streamPayload(event.data);

          if (payload === undefined) {
            yield streamErrorEvent(
              'lmstudio',
              'malformed_stream_event',
              'Malformed LM Studio stream event.',
              event.data,
              sensitiveOutput,
            );
            return;
          }

          if (event.event === 'message.delta') {
            const content = stringField(payload, 'content') ?? '';
            text.push(content);
            yield { type: 'text.delta', delta: content };
            continue;
          }

          if (event.event === 'reasoning.delta') {
            const content = stringField(payload, 'content') ?? '';
            reasoning.push(content);
            yield { type: 'reasoning.delta', delta: content };
            continue;
          }

          if (event.event === 'error') {
            yield streamErrorEvent(
              'lmstudio',
              'provider_error',
              errorMessage(payload),
              event.data,
              sensitiveOutput,
            );
            continue;
          }

          if (event.event === 'chat.end') {
            const result = recordField(payload, 'result') ?? payload;
            const finish = parseStructuredOutput(
              'lmstudio',
              request,
              finished(result, 'stop', text.join(''), reasoning.join('')),
              false,
            );

            if (finish.usage !== undefined) {
              yield { type: 'usage', usage: finish.usage };
            }

            yield { type: 'response.finished', finish };
            return;
          }
        }

        yield {
          type: 'response.finished',
          finish: parseStructuredOutput(
            'lmstudio',
            request,
            {
              text: text.join(''),
              finishReason: 'unknown',
              reasoning:
                reasoning.length === 0
                  ? undefined
                  : { text: reasoning.join('') },
              toolCalls: [],
            },
            false,
          ),
        };
      },

      async embedding(
        _request: ProviderEmbeddingRequest,
      ): Promise<ProviderEmbeddingFinished> {
        throw new ProviderErrorObject({
          provider: 'lmstudio',
          code: 'unsupported_embeddings',
          message: 'LM Studio provider does not support embeddings.',
        });
      },

      async rerank(
        _request: ProviderRerankRequest,
      ): Promise<ProviderRerankFinished> {
        throw new ProviderErrorObject({
          provider: 'lmstudio',
          code: 'unsupported_reranking',
          message: 'LM Studio provider does not support reranking.',
        });
      },

      async models(signal?: AbortSignal): Promise<readonly Model[]> {
        const response = await deps.transport.request({
          method: 'GET',
          url: `${baseUrl}/api/v1/models`,
          headers: {
            ...(await authHeader(deps)),
            accept: 'application/json',
          },
          signal,
        });

        if (response.status >= 400) {
          throw httpError('lmstudio', response.status, response.body);
        }

        return models(parseJsonBody('lmstudio', response.body));
      },

      async validateModel(model: string, signal?: AbortSignal): Promise<Model> {
        const found = (await this.models(signal)).find(
          (item) => item.id === model,
        );

        if (found === undefined) {
          throw new ProviderErrorObject({
            provider: 'lmstudio',
            code: 'missing_model',
            message: `LM Studio model is not available: ${model}`,
          });
        }

        return found;
      },
    },
    deps.logger,
  );
};

const chatBody = (
  request: ProviderRequest<unknown>,
  stream: boolean,
): Record<string, unknown> => {
  const messages = messagesWithStructuredSchema('lmstudio', request);

  return prune({
    model: request.model,
    input: input(messages),
    system_prompt: systemPrompt(messages),
    stream,
    temperature: request.temperature,
    max_output_tokens: request.maxOutputTokens,
    reasoning: reasoningEffort(request),
  });
};

const reasoningEffort = (
  request: ProviderRequest<unknown>,
): string | undefined => {
  const effort = requestReasoningEffort(request);

  if (effort === undefined) {
    return undefined;
  }

  return {
    none: 'off',
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
  }[effort];
};

const systemPrompt = (
  messages: readonly ProviderMessage[],
): string | undefined => {
  const text = messages
    .filter((message) => message.role === 'system')
    .map(messageText)
    .filter((item) => item !== '')
    .join('\n\n');

  return text === '' ? undefined : text;
};

const input = (messages: readonly ProviderMessage[]): string =>
  messages
    .filter((message) => message.role !== 'system')
    .map(inputMessage)
    .filter((item) => item !== '')
    .join('\n\n');

const inputMessage = (message: ProviderMessage): string => {
  const text = messageText(message);

  if (message.role === 'user' || text === '') {
    return text;
  }

  if (message.role === 'assistant') {
    return `Assistant: ${text}`;
  }

  return message.toolCallId === undefined
    ? `Tool: ${text}`
    : `Tool ${message.toolCallId}: ${text}`;
};

const finished = (
  response: Record<string, unknown>,
  finishReason: ProviderFinished['finishReason'],
  fallbackText = '',
  fallbackReasoning = '',
): ProviderFinished => {
  const output = arrayField(response, 'output').map(asRecord).filter(isRecord);
  const text = output
    .filter((item) => item.type === 'message')
    .map((item) => stringField(item, 'content') ?? '')
    .join('');
  const reasoning = output
    .filter((item) => item.type === 'reasoning')
    .map((item) => stringField(item, 'content') ?? '')
    .join('');

  return {
    text: text === '' ? fallbackText : text,
    finishReason,
    usage: usage(recordField(response, 'stats')),
    reasoning: reasoningValue(reasoning === '' ? fallbackReasoning : reasoning),
    toolCalls: [],
  };
};

const reasoningValue = (
  text: string,
): ProviderFinished['reasoning'] | undefined =>
  text === '' ? undefined : { text };

const usage = (
  stats: Record<string, unknown> | undefined,
): UsageMetadata | undefined => {
  if (stats === undefined) {
    return undefined;
  }

  const inputTokens = numberField(stats, 'input_tokens');
  const outputTokens = numberField(stats, 'total_output_tokens');
  const reasoningTokens = numberField(stats, 'reasoning_output_tokens');
  const totalTokens =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
  };
};

const models = (body: Record<string, unknown>): readonly Model[] =>
  arrayField(body, 'models')
    .map(asRecord)
    .filter(isRecord)
    .filter(isLlmModel)
    .map((model) => ({
      id: stringField(model, 'key') ?? '',
      name: stringField(model, 'display_name'),
      contextWindow: numberField(model, 'max_context_length'),
      provider: 'lmstudio',
      raw: model,
    }))
    .filter((model) => model.id !== '');

const streamPayload = (data: string): Record<string, unknown> | undefined => {
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return undefined;
  }
};

const errorMessage = (payload: Record<string, unknown>): string => {
  const value = payload.error;
  const record = asRecord(value);

  return (
    (typeof value === 'string' ? value : undefined) ??
    (record === undefined ? undefined : stringField(record, 'message')) ??
    'LM Studio stream error.'
  );
};

const isLlmModel = (model: Record<string, unknown>): boolean => {
  const type = stringField(model, 'type');

  return type === undefined || type === 'llm';
};

const authHeader = async (
  deps: LmStudioProviderDeps,
): Promise<Record<string, string>> => {
  const value = await authorization(deps);

  return value === undefined ? {} : { authorization: value };
};

const authorization = async (
  deps: LmStudioProviderDeps,
): Promise<string | undefined> => {
  const apiKey = await secret(deps.apiKey);
  const auth = await secret(deps.authorization);

  if (apiKey !== undefined && auth !== undefined) {
    throw new ProviderErrorObject({
      provider: 'lmstudio',
      code: 'auth_ambiguous',
      message:
        'LM Studio provider accepts either apiKey or authorization, not both.',
    });
  }

  if (apiKey !== undefined) {
    return `Bearer ${apiKey}`;
  }

  return auth;
};

const secret = async (
  source: SecretSource | undefined,
): Promise<string | undefined> => {
  if (source === undefined) {
    return undefined;
  }

  const value = typeof source === 'function' ? await source() : source;

  return value.trim() === '' ? undefined : value;
};

const prune = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );

const isRecord = (
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> => value !== undefined;
