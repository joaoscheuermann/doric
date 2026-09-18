import { ProviderErrorObject } from '../classes/provider-error.js';
import type {
  FinishReason,
  JsonObject,
  JsonValue,
  ProviderError,
  ProviderEmbeddingFinished,
  ProviderEmbeddingRequest,
  ProviderFinished,
  ProviderId,
  ProviderMessage,
  ProviderRequest,
  ProviderRerankRequest,
  ProviderRerankFinished,
  ProviderRerankResult,
  ProviderStructuredFinished,
  ReasoningEffort,
  StructuredOutputSchema,
  UsageMetadata,
} from '../types/provider.js';
import { diagnosticExcerpt } from '../utils/diagnostics.js';
import {
  arrayField,
  asRecord,
  numberField,
  recordField,
} from '../utils/json.js';
import { z } from 'zod';

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
  sensitiveOutput = false,
): ProviderErrorObject =>
  new ProviderErrorObject({
    provider,
    code: status === 401 || status === 403 ? 'auth_failed' : 'http_error',
    message: `${provider} request failed with HTTP ${status}.`,
    status,
    retryable: status === 429 || status >= 500,
    ...(sensitiveOutput ? {} : { diagnostic: diagnosticExcerpt(body) }),
  });

export const streamErrorEvent = (
  provider: ProviderId,
  code: string,
  message: string,
  diagnostic?: string,
  sensitiveOutput = false,
): { readonly type: 'error'; readonly error: ProviderError } => ({
  type: 'error',
  error: {
    provider,
    code,
    message: sensitiveOutput ? `${provider} stream failed.` : message,
    diagnostic:
      sensitiveOutput || diagnostic === undefined
        ? undefined
        : diagnosticExcerpt(diagnostic),
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
    promptDetails === undefined
      ? undefined
      : numberField(promptDetails, 'cached_tokens');
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
  sensitiveOutput = false,
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
      ...(sensitiveOutput ? {} : { diagnostic: diagnosticExcerpt(body) }),
    };
    throw sensitiveOutput
      ? new ProviderErrorObject(data)
      : new ProviderErrorObject(data, { cause });
  }

  throw new ProviderErrorObject({
    provider,
    code: 'invalid_json',
    message: `${provider} returned a non-object JSON body.`,
    ...(sensitiveOutput ? {} : { diagnostic: diagnosticExcerpt(body) }),
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

/** Converts a supported structured-output schema to a JSON Schema object. */
export const structuredJsonSchema = (
  provider: ProviderId,
  schema: StructuredOutputSchema | undefined,
): JsonObject | undefined => {
  if (schema === undefined) {
    return undefined;
  }

  if (!(schema instanceof z.ZodType)) {
    throw new ProviderErrorObject({
      provider,
      code: 'invalid_structured_schema',
      message: `${provider} structured output schema must be a Zod schema.`,
    });
  }

  let value: unknown;

  try {
    value = z.toJSONSchema(schema, {
      io: 'output',
      unrepresentable: 'throw',
    });
  } catch (cause) {
    throw new ProviderErrorObject(
      {
        provider,
        code: 'invalid_structured_schema',
        message: `${provider} structured output schema cannot be represented as JSON Schema.`,
      },
      { cause },
    );
  }

  const json = asJsonObject(value);

  if (json?.type !== 'object') {
    throw new ProviderErrorObject({
      provider,
      code: 'invalid_structured_schema',
      message: `${provider} structured output schema must produce an object JSON Schema.`,
    });
  }

  return json;
};

export const messagesWithStructuredSchema = (
  provider: ProviderId,
  request: ProviderRequest<unknown>,
  convertedSchema?: JsonObject,
): readonly ProviderMessage[] => {
  if (
    request.flags?.includeStructuredSchemaOnSystemPrompt !== true ||
    request.schema === undefined
  ) {
    return request.messages;
  }

  const schema =
    convertedSchema ?? structuredJsonSchema(provider, request.schema);

  if (schema === undefined) {
    return request.messages;
  }

  const content = structuredSchemaPrompt(schema);
  const system = request.messages.filter(
    (message) => message.role === 'system',
  );
  const nonSystem = request.messages.filter(
    (message) => message.role !== 'system',
  );

  return [...system, { role: 'system', content }, ...nonSystem];
};

/** Returns whether a JSON Schema meets the strict object rules used by APIs. */
export const isStrictCompatible = (value: JsonValue): boolean => {
  if (Array.isArray(value)) {
    return value.every(isStrictCompatible);
  }

  const record = asRecord(value);

  if (record === undefined) {
    return true;
  }

  const childrenAreStrict = Object.values(record).every((child) =>
    isStrictCompatible(child as JsonValue),
  );
  const properties = asRecord(record.properties);

  if (record.type !== 'object' || properties === undefined) {
    return childrenAreStrict;
  }

  const required = Array.isArray(record.required) ? record.required : [];

  return (
    record.additionalProperties === false &&
    Object.keys(properties).every((key) => required.includes(key)) &&
    childrenAreStrict
  );
};

const structuredSchemaPrompt = (schema: JsonObject): string => {
  const json = JSON.stringify(schema, null, 2);
  const fence = commonMarkFence(json);

  return `Return exactly one JSON object that matches the JSON Schema below. Output just the JSON object string, DO NOT include any Markdown fences or any text outside the JSON object.
${fence}json
${json}
${fence}`;
};

const commonMarkFence = (value: string): string => {
  const backticks = longestRun(value, /`+/g);
  const tildes = longestRun(value, /~+/g);
  const marker = backticks <= tildes ? '`' : '~';
  const longest = marker === '`' ? backticks : tildes;

  return marker.repeat(Math.max(3, longest + 1));
};

const longestRun = (value: string, pattern: RegExp): number =>
  Math.max(0, ...[...value.matchAll(pattern)].map(([run]) => run.length));

export const parseStructuredOutput = <Output = JsonValue>(
  provider: ProviderId,
  request: ProviderRequest<Output>,
  finish: ProviderFinished<unknown>,
  rejectNonStructured = true,
): ProviderFinished<Output> => {
  const schema = request.schema;

  if (schema === undefined) {
    return finish as ProviderFinished<Output>;
  }

  if (!rejectNonStructured) {
    return finish as ProviderFinished<Output>;
  }

  if (finish.refusal !== undefined || finish.toolCalls.length > 0) {
    throw new ProviderErrorObject({
      provider,
      code: 'invalid_structured_output',
      message: `${provider} returned a refusal or tool call instead of structured output.`,
    });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(finish.text) as unknown;
  } catch (cause) {
    const sensitiveOutput = request.flags?.sensitiveOutput === true;
    const data = {
      provider,
      code: 'invalid_structured_output',
      message: `${provider} returned invalid structured output.`,
      ...(sensitiveOutput
        ? {}
        : { diagnostic: structuredOutputDiagnostic(finish) }),
    };
    throw sensitiveOutput
      ? new ProviderErrorObject(data)
      : new ProviderErrorObject(data, { cause });
  }

  const structured: ProviderStructuredFinished<Output> = {
    ...finish,
    structured: validateStructuredOutput(
      provider,
      schema,
      parsed,
      request.flags?.sensitiveOutput === true,
    ) as Output,
  };

  return structured;
};

const structuredOutputDiagnostic = (
  finish: ProviderFinished<unknown>,
): string => {
  if (finish.text.trim() !== '') {
    return diagnosticExcerpt(finish.text);
  }

  return [
    'response text was empty',
    `finishReason=${finish.finishReason}`,
    ...(finish.usage?.outputTokens === undefined
      ? []
      : [`outputTokens=${finish.usage.outputTokens}`]),
    ...(finish.usage?.reasoningTokens === undefined
      ? []
      : [`reasoningTokens=${finish.usage.reasoningTokens}`]),
  ].join('; ');
};

const validateStructuredOutput = <Schema extends StructuredOutputSchema>(
  provider: ProviderId,
  schema: Schema,
  value: unknown,
  sensitiveOutput: boolean,
): z.output<Schema> => {
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new ProviderErrorObject({
    provider,
    code: 'invalid_structured_output',
    message: `${provider} structured output failed schema validation.`,
    ...(sensitiveOutput
      ? {}
      : { diagnostic: parsed.error.issues.map(issueDiagnostic).join('; ') }),
  });
};

const issueDiagnostic = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.map(String).join('.');

  return path === '' ? issue.message : `${path}: ${issue.message}`;
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return Number.isFinite(value) || typeof value !== 'number';
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
};

const asJsonObject = (value: unknown): JsonObject | undefined =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  isJsonValue(value)
    ? (value as JsonObject)
    : undefined;
