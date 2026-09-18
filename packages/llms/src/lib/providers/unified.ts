import { ProviderErrorObject } from '../classes/provider-error.js';
import type {
  JsonValue,
  LlmProvider,
  ProviderFinished,
  ProviderMetadata,
  ProviderRequest,
  ProviderStructuredFinished,
  ProviderStreamEvent,
  StructuredOutputSchema,
  StructuredOutputValue,
  UsageMetadata,
} from '../types/provider.js';
import { parseStructuredOutput } from './common.js';
import { withProviderLogging } from './logging.js';
import {
  createOpenRouterProviderCore,
  openRouterCapabilities,
  openRouterMetadata,
  type OpenRouterProviderDeps,
  type PreparedOpenRouterRequest,
} from './openrouter.js';
import { createOpenRouterCatalog } from './unified/catalog.js';
import { createUnifiedRequestPreparer } from './unified/prepare.js';

export type UnifiedProviderDeps = OpenRouterProviderDeps & {
  readonly maxStructuredOutputRepairs?: number;
  /** Original model id used for curated capabilities when requests carry a proxy alias. */
  readonly upstreamModel?: string;
};

export const unifiedMetadata: ProviderMetadata = {
  id: 'unified',
  name: 'Unified (OpenRouter)',
  baseUrl: openRouterMetadata.baseUrl,
};

export const unifiedCapabilities = openRouterCapabilities;

export const createUnifiedProvider = (
  deps: UnifiedProviderDeps,
): LlmProvider => {
  const maxRepairs = repairLimit(deps.maxStructuredOutputRepairs);
  const upstreamModel = normalizedUpstreamModel(deps.upstreamModel);
  let prepareRequest = async (
    request: ProviderRequest<unknown>,
  ): Promise<PreparedOpenRouterRequest> => ({ request });
  const core = createOpenRouterProviderCore(deps, {
    metadata: unifiedMetadata,
    validateStructuredOutput: false,
    prepare: (request) => prepareRequest(request),
  });
  const resolveSupport = createOpenRouterCatalog((signal) =>
    core.models(signal),
  );
  prepareRequest = createUnifiedRequestPreparer(resolveSupport, upstreamModel);

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
    if (request.schema === undefined) {
      return core.complete(request);
    }

    let attempt: ProviderRequest<Output> = request;
    let usage: UsageMetadata | undefined;

    for (let repairs = 0; ; repairs += 1) {
      const finish = (await core.complete(
        attempt,
      )) as ProviderFinished<unknown>;
      usage = addUsage(usage, finish.usage);
      const accumulated = usage === undefined ? finish : { ...finish, usage };

      try {
        return parseStructuredOutput('unified', request, accumulated);
      } catch (error) {
        if (!isRepairable(error) || repairs >= maxRepairs) throw error;
        attempt = structuredRepairRequest(attempt, finish);
      }
    }
  }

  const provider: LlmProvider = {
    metadata: unifiedMetadata,
    capabilities: unifiedCapabilities,
    complete,

    async *stream<Output = JsonValue>(
      request: ProviderRequest<Output>,
    ): AsyncIterable<ProviderStreamEvent<Output>> {
      if (request.schema === undefined) {
        yield* core.stream(request);
        return;
      }

      const finish = await complete(request);
      yield {
        type: 'response.started',
        provider: unifiedMetadata.id,
        model: request.model,
      };
      if (finish.text.length > 0) {
        yield { type: 'text.delta', delta: finish.text };
      }
      yield { type: 'response.finished', finish };
    },

    embedding: (request) => core.embedding(request),
    rerank: (request) => core.rerank(request),
    models: (signal) => core.models(signal),
    validateModel: (model, signal) => core.validateModel(model, signal),
  };

  return withProviderLogging(provider, deps.logger);
};

const normalizedUpstreamModel = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;

  const normalized = value.trim();
  if (normalized.length > 0) return normalized;
  throw new TypeError('Unified provider upstreamModel must not be blank.');
};

const defaultStructuredOutputRepairs = 2;

const repairLimit = (value: number | undefined): number => {
  const limit = value ?? defaultStructuredOutputRepairs;

  if (Number.isSafeInteger(limit) && limit >= 0) return limit;
  throw new TypeError(
    'Unified provider maxStructuredOutputRepairs must be a non-negative safe integer.',
  );
};

const isRepairable = (error: unknown): boolean =>
  error instanceof ProviderErrorObject &&
  error.data.code === 'invalid_structured_output';

const structuredRepairRequest = <Output>(
  request: ProviderRequest<Output>,
  finish: ProviderFinished<unknown>,
): ProviderRequest<Output> => ({
  ...request,
  messages: [
    ...request.messages,
    {
      role: 'assistant',
      content: finish.text,
      ...(finish.replay === undefined ? {} : { replay: finish.replay }),
    },
    { role: 'user', content: structuredOutputCorrection },
  ],
});

const structuredOutputCorrection = [
  '# Structured output correction',
  '',
  'The previous response was rejected because it did not match the required JSON object schema.',
  'Return exactly one corrected JSON object. Do not include Markdown or explanatory text.',
].join('\n');

const addUsage = (
  left: UsageMetadata | undefined,
  right: UsageMetadata | undefined,
): UsageMetadata | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;

  return usage({
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    totalTokens: add(left.totalTokens, right.totalTokens),
    reasoningTokens: add(left.reasoningTokens, right.reasoningTokens),
    cachedInputTokens: add(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: add(left.cacheWriteTokens, right.cacheWriteTokens),
    searchUnits: add(left.searchUnits, right.searchUnits),
    cost: addCost(left.cost, right.cost),
  });
};

const addCost = (
  left: UsageMetadata['cost'],
  right: UsageMetadata['cost'],
): UsageMetadata['cost'] => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (
    left.unit !== undefined &&
    right.unit !== undefined &&
    left.unit !== right.unit
  ) {
    return undefined;
  }

  return {
    amount: left.amount + right.amount,
    ...(left.unit === undefined && right.unit === undefined
      ? {}
      : { unit: left.unit ?? right.unit }),
    ...(left.upstreamAmount === undefined && right.upstreamAmount === undefined
      ? {}
      : {
          upstreamAmount:
            (left.upstreamAmount ?? 0) + (right.upstreamAmount ?? 0),
        }),
  };
};

const usage = (value: UsageMetadata): UsageMetadata =>
  Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as UsageMetadata;

const add = (
  left: number | undefined,
  right: number | undefined,
): number | undefined =>
  left === undefined && right === undefined
    ? undefined
    : (left ?? 0) + (right ?? 0);
