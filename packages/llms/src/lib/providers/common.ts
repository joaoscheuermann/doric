import { ProviderErrorObject } from '../classes/provider-error.js';
import type {
  FinishReason,
  ProviderError,
  ProviderEmbeddingFinished,
  ProviderEmbeddingRequest,
  ProviderId,
  ProviderMessage,
  ProviderRequest,
  ProviderRerankRequest,
  ProviderRerankFinished,
  ProviderRerankResult,
  ReasoningEffort,
  UsageMetadata,
} from '../types/provider.js';
import { diagnosticExcerpt } from '../utils/diagnostics.js';
import {
  arrayField,
  asRecord,
  numberField,
  recordField,
} from '../utils/json.js';

export const requireRequestInput = (
  provider: ProviderId,
  request: ProviderRequest<unknown>,
): void => {
  if (request.model.trim() === '') {
    throw new ProviderErrorObject({
      provider,
      code: 'missing_model',
      message: 'Provider request requires a model.',
    });
  }

  if (request.messages.length === 0) {
    throw new ProviderErrorObject({
      provider,
      code: 'missing_input',
      message: 'Provider request requires at least one message.',
    });
  }
};

export const requireEmbeddingInput = (
  provider: ProviderId,
  request: ProviderEmbeddingRequest,
): void => {
  if (request.model.trim() === '') {
    throw new ProviderErrorObject({
      provider,
      code: 'missing_model',
      message: 'Provider request requires a model.',
    });
  }

  if (request.input.trim() === '') {
    throw new ProviderErrorObject({
      provider,
      code: 'missing_input',
      message: 'Provider request requires input.',
    });
  }

  if (
    request.dimensions !== undefined &&
    (!Number.isInteger(request.dimensions) || request.dimensions < 1)
  ) {
    throw new ProviderErrorObject({
      provider,
      code: 'invalid_dimensions',
      message: 'Provider embedding dimensions must be a positive integer.',
    });
  }
};

export const requireRerankInput = (
  provider: ProviderId,
  request: ProviderRerankRequest,
): void => {
  if (request.model.trim() === '') {
    throw new ProviderErrorObject({
      provider,
      code: 'missing_model',
      message: 'Provider request requires a model.',
    });
  }

  if (
    request.query.trim() === '' ||
    request.documents.length === 0 ||
    request.documents.some((document) => document.trim() === '')
  ) {
    throw new ProviderErrorObject({
      provider,
      code: 'missing_input',
      message: 'Provider rerank request requires a query and documents.',
    });
  }

  if (
    request.topN !== undefined &&
    (!Number.isInteger(request.topN) || request.topN < 1)
  ) {
    throw new ProviderErrorObject({
      provider,
      code: 'invalid_top_n',
      message: 'Provider rerank request topN must be a positive integer.',
    });
  }
};

export const requestReasoningEffort = (
  request: ProviderRequest<unknown>,
): ReasoningEffort | undefined => {
  if (request.effort !== undefined) {
    return request.effort;
  }

  const value = request.flags?.reasoning;

  return typeof value === 'object' ? value.effort : undefined;
};

export const messageText = (message: ProviderMessage): string => {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return (message.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
};

export const httpError = (
  provider: ProviderId,
  status: number,
  body: string,
): ProviderErrorObject =>
  new ProviderErrorObject({
    provider,
    code: status === 401 || status === 403 ? 'auth_failed' : 'http_error',
    message: `${provider} request failed with HTTP ${status}.`,
    status,
    retryable: status === 429 || status >= 500,
    diagnostic: diagnosticExcerpt(body),
  });

export const streamErrorEvent = (
  provider: ProviderId,
  code: string,
  message: string,
  diagnostic?: string,
): { readonly type: 'error'; readonly error: ProviderError } => ({
  type: 'error',
  error: {
    provider,
    code,
    message,
    diagnostic:
      diagnostic === undefined ? undefined : diagnosticExcerpt(diagnostic),
  },
});

export const parseUsage = (
  usage: Record<string, unknown> | undefined,
  costUnit?: string,
): UsageMetadata | undefined => {
  if (usage === undefined) {
    return undefined;
  }

  const details =
    recordField(usage, 'completion_tokens_details') ??
    recordField(usage, 'output_tokens_details');
  const inputDetails = recordField(usage, 'input_tokens_details');
  const promptDetails = recordField(usage, 'prompt_tokens_details');
  const inputTokens =
    numberField(usage, 'input_tokens') ?? numberField(usage, 'prompt_tokens');
  const outputTokens =
    numberField(usage, 'output_tokens') ??
    numberField(usage, 'completion_tokens');
  const totalTokens = numberField(usage, 'total_tokens');
  const reasoningTokens =
    numberField(usage, 'reasoning_tokens') ??
    (details === undefined
      ? undefined
      : numberField(details, 'reasoning_tokens'));
  const cachedInputTokens =
    (inputDetails === undefined
      ? undefined
      : numberField(inputDetails, 'cached_tokens')) ??
    (promptDetails === undefined
      ? undefined
      : numberField(promptDetails, 'cached_tokens'));
  const cacheWriteTokens =
    promptDetails === undefined
      ? undefined
      : numberField(promptDetails, 'cache_write_tokens');
  const searchUnits = numberField(usage, 'search_units');
  const amount = numberField(usage, 'cost');
  const costDetails = recordField(usage, 'cost_details');
  const upstreamAmount =
    costDetails === undefined
      ? undefined
      : numberField(costDetails, 'upstream_inference_cost');

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(searchUnits === undefined ? {} : { searchUnits }),
    ...(amount === undefined
      ? {}
      : {
          cost: {
            amount,
            ...(costUnit === undefined ? {} : { unit: costUnit }),
            ...(upstreamAmount === undefined ? {} : { upstreamAmount }),
          },
        }),
  };
};

export const finishReason = (value: unknown): FinishReason => {
  if (
    value === 'stop' ||
    value === 'length' ||
    value === 'tool_calls' ||
    value === 'content_filter'
  ) {
    return value;
  }

  if (value === 'cancelled') {
    return 'cancelled';
  }

  if (value === 'error' || value === 'failed') {
    return 'error';
  }

  return 'unknown';
};

export const parseJsonBody = (
  provider: ProviderId,
  body: string,
): Record<string, unknown> => {
  try {
    const parsed = asRecord(JSON.parse(body));

    if (parsed !== undefined) {
      return parsed;
    }
  } catch (cause) {
    const data = {
      provider,
      code: 'invalid_json',
      message: `${provider} returned invalid JSON.`,
      diagnostic: diagnosticExcerpt(body),
    };
    throw new ProviderErrorObject(data, { cause });
  }

  throw new ProviderErrorObject({
    provider,
    code: 'invalid_json',
    message: `${provider} returned a non-object JSON body.`,
    diagnostic: diagnosticExcerpt(body),
  });
};

export const parseEmbedding = (
  provider: ProviderId,
  body: Record<string, unknown>,
  costUnit?: string,
): ProviderEmbeddingFinished => {
  const data = arrayField(body, 'data');
  const embedding = arrayField(asRecord(data[0]) ?? {}, 'embedding');

  if (embedding.length > 0 && embedding.every(isFiniteNumber)) {
    const usage = parseUsage(recordField(body, 'usage'), costUnit);
    return {
      embedding: embedding as readonly number[],
      ...(usage === undefined ? {} : { usage }),
    };
  }

  throw new ProviderErrorObject({
    provider,
    code: 'invalid_embedding',
    message: `${provider} returned an invalid embedding.`,
  });
};

export const parseRerank = (
  provider: ProviderId,
  body: Record<string, unknown>,
  costUnit?: string,
): ProviderRerankFinished => {
  const results = arrayField(body, 'results');
  const parsed = results.map((value) => {
    const result = asRecord(value);
    const index =
      result === undefined ? undefined : numberField(result, 'index');
    const relevanceScore =
      result === undefined ? undefined : numberField(result, 'relevance_score');

    return index !== undefined &&
      Number.isInteger(index) &&
      index >= 0 &&
      relevanceScore !== undefined &&
      Number.isFinite(relevanceScore)
      ? { index, relevanceScore }
      : undefined;
  });

  if (parsed.length > 0 && parsed.every(isRerankResult)) {
    const usage = parseUsage(recordField(body, 'usage'), costUnit);
    return {
      results: parsed,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  throw new ProviderErrorObject({
    provider,
    code: 'invalid_rerank',
    message: `${provider} returned an invalid rerank response.`,
  });
};

const isRerankResult = (
  value: ProviderRerankResult | undefined,
): value is ProviderRerankResult => value !== undefined;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
