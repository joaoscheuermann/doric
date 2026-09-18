import type { Logger } from 'pino';

import type {
  JsonValue,
  LlmProvider,
  ProviderFinished,
  ProviderRequest,
  ProviderRerankRequest,
  ProviderStructuredFinished,
  ProviderStreamEvent,
  StructuredOutputSchema,
  StructuredOutputValue,
  UsageMetadata,
} from '../types/provider.js';

type Fields = Readonly<Record<string, unknown>>;
type Terminal = 'completed' | 'failed' | 'cancelled';

const operationNames = {
  complete: 'completion',
  stream: 'stream',
  embedding: 'embedding',
  rerank: 'rerank',
  models: 'model listing',
  validateModel: 'model validation',
} as const;

type Operation = keyof typeof operationNames;

/** Adds privacy-safe, uniform operational events to an LLM provider. */
export const withProviderLogging = (
  provider: LlmProvider,
  logger: Logger,
): LlmProvider => {
  assertLogger(logger);
  const log = logger.child({
    component: 'llms',
    provider: provider.metadata.id,
  });
  assertLogger(log);
  log.debug('llm provider initialized');

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
    return loggedPromise(
      log,
      'complete',
      requestFields(request),
      request.flags?.sensitiveOutput === true,
      request.signal,
      () => provider.complete(request),
      finishFields,
    );
  }

  function stream<Schema extends StructuredOutputSchema>(
    request: ProviderRequest<StructuredOutputValue<Schema>, Schema> & {
      readonly schema: Schema;
    },
  ): AsyncIterable<ProviderStreamEvent<StructuredOutputValue<Schema>>>;
  function stream<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): AsyncIterable<ProviderStreamEvent<Output>>;
  function stream<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): AsyncIterable<ProviderStreamEvent<Output>> {
    return loggedStream(log, provider.stream(request), request);
  }

  return {
    metadata: provider.metadata,
    capabilities: provider.capabilities,
    complete,
    stream,

    embedding(request) {
      return loggedPromise(
        log,
        'embedding',
        { model: request.model },
        request.flags?.sensitiveOutput === true,
        request.signal,
        () => provider.embedding(request),
        ({ embedding, usage }) => ({
          dimensions: embedding.length,
          ...usageFields(usage),
        }),
      );
    },

    rerank(request) {
      return loggedPromise(
        log,
        'rerank',
        rerankFields(request),
        request.flags?.sensitiveOutput === true,
        request.signal,
        () => provider.rerank(request),
        ({ results, usage }) => ({
          resultCount: results.length,
          ...usageFields(usage),
        }),
      );
    },

    models(signal) {
      return loggedPromise(
        log,
        'models',
        {},
        false,
        signal,
        () => provider.models(signal),
        (models) => ({ modelCount: models.length }),
      );
    },

    validateModel(model, signal) {
      return loggedPromise(
        log,
        'validateModel',
        { model },
        false,
        signal,
        () => provider.validateModel(model, signal),
        (validated) => ({ model: validated.id }),
      );
    },
  };
};

const loggedPromise = async <Result>(
  logger: Logger,
  operation: Operation,
  startedFields: Fields,
  sensitive: boolean,
  signal: AbortSignal | undefined,
  execute: () => Promise<Result>,
  completedFields: (result: Result) => Fields,
): Promise<Result> => {
  debug(logger, operation, 'started', startedFields, sensitive);

  try {
    const result = await execute();
    debug(logger, operation, 'completed', completedFields(result), sensitive);
    return result;
  } catch (error) {
    debug(
      logger,
      operation,
      cancelled(error, signal) ? 'cancelled' : 'failed',
      {},
      sensitive,
    );
    throw error;
  }
};

async function* loggedStream<Output>(
  logger: Logger,
  source: AsyncIterable<ProviderStreamEvent<Output>>,
  request: ProviderRequest<Output>,
): AsyncIterable<ProviderStreamEvent<Output>> {
  const sensitive = request.flags?.sensitiveOutput === true;
  let terminal = false;
  debug(logger, 'stream', 'started', requestFields(request), sensitive);

  try {
    for await (const event of source) {
      if (!terminal && event.type === 'error') {
        terminal = true;
        debug(logger, 'stream', 'failed', {}, sensitive);
      } else if (!terminal && event.type === 'response.finished') {
        terminal = true;
        const status = terminalFromFinish(event.finish);
        debug(logger, 'stream', status, finishFields(event.finish), sensitive);
      }

      yield event;
    }

    if (!terminal) {
      terminal = true;
      debug(logger, 'stream', 'completed', {}, sensitive);
    }
  } catch (error) {
    if (!terminal) {
      terminal = true;
      debug(
        logger,
        'stream',
        cancelled(error, request.signal) ? 'cancelled' : 'failed',
        {},
        sensitive,
      );
    }
    throw error;
  } finally {
    if (!terminal) {
      debug(logger, 'stream', 'cancelled', {}, sensitive);
    }
  }
}

const debug = (
  logger: Logger,
  operation: Operation,
  status: 'started' | Terminal,
  fields: Fields,
  sensitive: boolean,
): void => {
  if (!sensitive) {
    logger.debug(fields, `llm ${operationNames[operation]} ${status}`);
  }
};

const requestFields = (request: ProviderRequest<unknown>): Fields => ({
  model: request.model,
  messageCount: request.messages.length,
  toolCount: request.tools?.length ?? 0,
  hasSchema: request.schema !== undefined,
});

const rerankFields = (request: ProviderRerankRequest): Fields => ({
  model: request.model,
  documentCount: request.documents.length,
});

const finishFields = (finish: ProviderFinished<unknown>): Fields => ({
  finishReason: finish.finishReason,
  toolCount: finish.toolCalls.length,
  ...usageFields(finish.usage),
});

const usageFields = (usage: UsageMetadata | undefined): Fields =>
  usage === undefined
    ? {}
    : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        searchUnits: usage.searchUnits,
        cost: usage.cost?.amount,
        costUnit: usage.cost?.unit,
        upstreamCost: usage.cost?.upstreamAmount,
      };

const terminalFromFinish = (finish: ProviderFinished<unknown>): Terminal => {
  if (finish.finishReason === 'cancelled') {
    return 'cancelled';
  }

  return finish.finishReason === 'error' ? 'failed' : 'completed';
};

const cancelled = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true ||
  (error instanceof Error && error.name === 'AbortError');

const assertLogger = (logger: Logger): void => {
  if (
    logger === null ||
    typeof logger !== 'object' ||
    typeof logger.debug !== 'function' ||
    typeof logger.child !== 'function'
  ) {
    throw new TypeError('LLM provider requires a Pino-compatible logger.');
  }
};
