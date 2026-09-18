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
  ProviderMetadata,
  ProviderRequest,
  ProviderRerankRequest,
  ProviderRerankFinished,
  ProviderStructuredFinished,
  ProviderStreamEvent,
  StructuredOutputSchema,
  StructuredOutputValue,
} from '../types/provider.js';
import { parseSseEvents } from '../utils/sse.js';
import {
  httpError,
  parseEmbedding,
  parseRerank,
  parseJsonBody,
  parseStructuredOutput,
  requireEmbeddingInput,
  requireRerankInput,
  requireRequestInput,
  streamErrorEvent,
} from './common.js';
import { authorization } from './openrouter/auth.js';
import {
  openRouterBody,
  type OpenRouterBodyOptions,
} from './openrouter/body.js';
import { modelsFromResponse } from './openrouter/models.js';
import {
  createStreamState,
  hasProviderError,
  parseFinished,
  streamEvents,
  streamFinish,
  streamToolCalls,
} from './openrouter/parse.js';
import { withProviderLogging } from './logging.js';

export { openRouterBody } from './openrouter/body.js';

export type OpenRouterProviderDeps = {
  readonly transport: HttpTransport;
  readonly apiKey: string | (() => string | Promise<string>);
  readonly baseUrl?: string;
  readonly logger: Logger;
};

export type PreparedOpenRouterRequest = {
  readonly request: ProviderRequest<unknown>;
  readonly bodyOptions?: OpenRouterBodyOptions;
};

export type OpenRouterProviderCoreOptions = {
  readonly metadata?: ProviderMetadata;
  readonly validateStructuredOutput?: boolean;
  readonly prepare?: (
    request: ProviderRequest<unknown>,
  ) => PreparedOpenRouterRequest | Promise<PreparedOpenRouterRequest>;
};

export const openRouterMetadata: ProviderMetadata = {
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
};

export const openRouterCapabilities: ProviderCapabilities = {
  streaming: true,
  embeddings: true,
  reranking: true,
  tools: true,
  reasoning: true,
  modelListing: true,
  oauth: false,
  serviceTier: false,
  structuredOutputs: true,
};

export const createOpenRouterProvider = (
  deps: OpenRouterProviderDeps,
): LlmProvider =>
  withProviderLogging(createOpenRouterProviderCore(deps), deps.logger);

/** Shared unlogged transport core used by OpenRouter policy adapters. */
export const createOpenRouterProviderCore = (
  deps: OpenRouterProviderDeps,
  options: OpenRouterProviderCoreOptions = {},
): LlmProvider => {
  const baseUrl = deps.baseUrl ?? openRouterMetadata.baseUrl;
  const metadata = options.metadata ?? openRouterMetadata;
  const providerId = metadata.id;
  const prepare = async (
    request: ProviderRequest<unknown>,
  ): Promise<PreparedOpenRouterRequest> =>
    options.prepare === undefined
      ? { request }
      : await options.prepare(request);

  const post = async (
    request: ProviderRequest<unknown>,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const sensitiveOutput = request.flags?.sensitiveOutput === true;
    const response = await deps.transport.request({
      method: 'POST',
      url: `${baseUrl}/chat/completions`,
      headers: {
        authorization: await authorization(deps.apiKey),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (response.status >= 400) {
      throw httpError(
        providerId,
        response.status,
        response.body,
        sensitiveOutput,
      );
    }

    return parseJsonBody(providerId, response.body, sensitiveOutput);
  };

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
    requireRequestInput(providerId, request);
    const prepared = await prepare(request);
    const body = openRouterBody(prepared.request, false, {
      ...prepared.bodyOptions,
      providerId,
    });
    const finish = parseFinished(await post(prepared.request, body));

    return options.validateStructuredOutput === false
      ? (finish as ProviderFinished<Output>)
      : parseStructuredOutput(providerId, request, finish);
  }

  return {
    metadata,
    capabilities: openRouterCapabilities,

    complete,

    async *stream<Output = JsonValue>(
      request: ProviderRequest<Output>,
    ): AsyncIterable<ProviderStreamEvent<Output>> {
      requireRequestInput(providerId, request);
      const prepared = await prepare(request);
      const sensitiveOutput = prepared.request.flags?.sensitiveOutput === true;
      const body = openRouterBody(prepared.request, true, {
        ...prepared.bodyOptions,
        providerId,
      });
      const chunks = deps.transport.stream({
        method: 'POST',
        url: `${baseUrl}/chat/completions`,
        headers: {
          authorization: await authorization(deps.apiKey),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: prepared.request.signal,
      });
      const state = createStreamState();

      yield {
        type: 'response.started',
        provider: providerId,
        model: request.model,
      };

      for await (const event of parseSseEvents(chunks)) {
        if (event.done) {
          break;
        }

        let payload: Record<string, unknown>;

        try {
          payload = parseJsonBody(providerId, event.data, sensitiveOutput);
        } catch {
          yield streamErrorEvent(
            providerId,
            'malformed_stream_event',
            event.data,
            undefined,
            sensitiveOutput,
          );
          return;
        }

        if (hasProviderError(payload)) {
          yield streamErrorEvent(
            providerId,
            'provider_error',
            'OpenRouter stream error.',
            event.data,
            sensitiveOutput,
          );
          return;
        }

        for (const parsed of streamEvents(payload, state)) {
          yield parsed;
        }
      }

      for (const call of streamToolCalls(state)) {
        yield { type: 'tool_call.done', call };
      }

      yield {
        type: 'response.finished',
        finish:
          options.validateStructuredOutput === false
            ? (streamFinish(state) as ProviderFinished<Output>)
            : parseStructuredOutput(
                providerId,
                request,
                streamFinish(state),
                false,
              ),
      };
    },

    async embedding(
      request: ProviderEmbeddingRequest,
    ): Promise<ProviderEmbeddingFinished> {
      requireEmbeddingInput(providerId, request);
      const sensitiveOutput = request.flags?.sensitiveOutput === true;
      const body = {
        model: request.model,
        input: request.input,
        ...(request.dimensions === undefined
          ? {}
          : { dimensions: request.dimensions }),
      };
      const response = await deps.transport.request({
        method: 'POST',
        url: `${baseUrl}/embeddings`,
        headers: {
          authorization: await authorization(deps.apiKey),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (response.status >= 400) {
        throw httpError(
          providerId,
          response.status,
          response.body,
          sensitiveOutput,
        );
      }

      return parseEmbedding(
        providerId,
        parseJsonBody(providerId, response.body, sensitiveOutput),
        'credits',
      );
    },

    async rerank(
      request: ProviderRerankRequest,
    ): Promise<ProviderRerankFinished> {
      requireRerankInput(providerId, request);
      const sensitiveOutput = request.flags?.sensitiveOutput === true;
      const body = {
        model: request.model,
        query: request.query,
        documents: request.documents,
        ...(request.topN === undefined ? {} : { top_n: request.topN }),
      };
      const response = await deps.transport.request({
        method: 'POST',
        url: `${baseUrl}/rerank`,
        headers: {
          authorization: await authorization(deps.apiKey),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (response.status >= 400) {
        throw httpError(
          providerId,
          response.status,
          response.body,
          sensitiveOutput,
        );
      }

      return parseRerank(
        providerId,
        parseJsonBody(providerId, response.body, sensitiveOutput),
        'credits',
      );
    },

    async models(signal?: AbortSignal): Promise<readonly Model[]> {
      const response = await deps.transport.request({
        method: 'GET',
        url: `${baseUrl}/models`,
        headers: {
          authorization: await authorization(deps.apiKey),
          accept: 'application/json',
        },
        signal,
      });

      if (response.status >= 400) {
        throw httpError(providerId, response.status, response.body);
      }

      return modelsFromResponse(parseJsonBody(providerId, response.body));
    },

    async validateModel(model: string, signal?: AbortSignal): Promise<Model> {
      const found = (await this.models(signal)).find(
        (item) => item.id === model,
      );

      if (found === undefined) {
        throw new ProviderErrorObject({
          provider: providerId,
          code: 'missing_model',
          message: `OpenRouter model is not available: ${model}`,
        });
      }

      return found;
    },
  };
};
