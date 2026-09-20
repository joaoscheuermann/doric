import type { Logger } from 'pino';

import { ProviderErrorObject } from '../classes/provider-error.js';
import type {
  DecisionProvider,
  DecisionQuestions,
  ProviderDecisionFinished,
  ProviderDecisionRequest,
} from '../types/decision.js';
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
  parseEmbedding,
  parseRerank,
  parseJsonBody,
  requireEmbeddingInput,
  requireRerankInput,
  requireRequestInput,
  streamErrorEvent,
} from './common.js';
import { parseStructuredOutput } from './structured.js';
import { authorization } from './openrouter/auth.js';
import {
  openRouterBody,
  type OpenRouterBodyOptions,
} from './openrouter/body.js';
import {
  openRouterDecisionBody,
  openRouterDecisionsUrl,
  parseDecisionFinished,
  requireDecisionInput,
} from './openrouter/decisions.js';
import { createOpenRouterModelsLoader } from './openrouter/models.js';
import {
  createStreamState,
  hasProviderError,
  parseFinished,
  streamEvents,
  streamFinish,
  streamToolCalls,
} from './openrouter/parse.js';
import { withProviderLogging } from './logging.js';
import { requestJson, withProviderErrors } from './http.js';

export { openRouterBody } from './openrouter/body.js';

export type OpenRouterProviderDeps = {
  readonly transport: HttpTransport;
  readonly apiKey: string | (() => string | Promise<string>);
  readonly baseUrl?: string;
  readonly logger: Logger;
};

export type OpenRouterProvider = LlmProvider & DecisionProvider;

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
): OpenRouterProvider =>
  withProviderLogging(createOpenRouterProviderCore(deps), deps.logger);

/** Shared unlogged transport core used by OpenRouter policy adapters. */
export const createOpenRouterProviderCore = (
  dependencies: OpenRouterProviderDeps,
  options: OpenRouterProviderCoreOptions = {},
): OpenRouterProvider => {
  const metadata = options.metadata ?? openRouterMetadata;
  const providerId = metadata.id;
  const deps = {
    ...dependencies,
    transport: withProviderErrors(dependencies.transport, providerId),
  };
  const baseUrl = deps.baseUrl ?? openRouterMetadata.baseUrl;
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
    return requestJson(deps.transport, providerId, {
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

    async decide<Questions extends DecisionQuestions>(
      request: ProviderDecisionRequest<Questions>,
    ): Promise<ProviderDecisionFinished<Questions>> {
      requireDecisionInput(providerId, request);
      const response = await requestJson(deps.transport, providerId, {
        method: 'POST',
        url: openRouterDecisionsUrl(baseUrl),
        headers: {
          authorization: await authorization(deps.apiKey),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(openRouterDecisionBody(request)),
        signal: request.signal,
      });

      return parseDecisionFinished(providerId, request.questions, response);
    },

    async *stream<Output = JsonValue>(
      request: ProviderRequest<Output>,
    ): AsyncIterable<ProviderStreamEvent<Output>> {
      requireRequestInput(providerId, request);
      const prepared = await prepare(request);
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
          payload = parseJsonBody(providerId, event.data);
        } catch {
          yield streamErrorEvent(
            providerId,
            'malformed_stream_event',
            event.data,
            undefined,
          );
          return;
        }

        if (hasProviderError(payload)) {
          yield streamErrorEvent(
            providerId,
            'provider_error',
            'OpenRouter stream error.',
            event.data,
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
      const body = {
        model: request.model,
        input: request.input,
        ...(request.dimensions === undefined
          ? {}
          : { dimensions: request.dimensions }),
      };
      const response = await requestJson(deps.transport, providerId, {
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
      return parseEmbedding(providerId, response, 'credits');
    },

    async rerank(
      request: ProviderRerankRequest,
    ): Promise<ProviderRerankFinished> {
      requireRerankInput(providerId, request);
      const body = {
        model: request.model,
        query: request.query,
        documents: request.documents,
        ...(request.topN === undefined ? {} : { top_n: request.topN }),
      };
      const response = await requestJson(deps.transport, providerId, {
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
      return parseRerank(providerId, response, 'credits');
    },

    models: createOpenRouterModelsLoader(deps, baseUrl, providerId),

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
