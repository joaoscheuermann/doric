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
  ProviderToolCall,
  StructuredOutputSchema,
  StructuredOutputValue,
} from '../types/provider.js';
import {
  asRecord,
  arrayField,
  recordField,
  stringField,
} from '../utils/json.js';
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
import { authorization, type SecretSource } from './openai/auth.js';
import { openAiBody } from './openai/body.js';
import {
  createTextSnapshots,
  parseFinished,
  recordTextSnapshot,
  streamEvent,
  streamText,
} from './openai/parse.js';
import { parseSseEvents } from '../utils/sse.js';
import { withProviderLogging } from './logging.js';

export type { SecretSource } from './openai/auth.js';
export { openAiBody } from './openai/body.js';

export type OpenAiProviderDeps = {
  readonly transport: HttpTransport;
  readonly apiKey?: SecretSource;
  readonly authorization?: SecretSource;
  readonly baseUrl?: string;
  readonly logger: Logger;
};

export type OpenAiCompatibleProviderDeps = OpenAiProviderDeps & {
  readonly identity: {
    readonly id: string;
    readonly name: string;
  };
};

export const openAiMetadata: ProviderMetadata = {
  id: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
};

export const openAiCapabilities: ProviderCapabilities = {
  streaming: true,
  embeddings: true,
  reranking: true,
  tools: true,
  reasoning: true,
  modelListing: true,
  oauth: false,
  serviceTier: true,
  structuredOutputs: true,
};

export const createOpenAiProvider = (deps: OpenAiProviderDeps): LlmProvider =>
  withProviderLogging(createOpenAiProviderCore(deps), deps.logger);

/** Creates a Responses-compatible provider while preserving its configured identity. */
export const createOpenAiCompatibleProvider = (
  deps: OpenAiCompatibleProviderDeps,
): LlmProvider => {
  const baseUrl = deps.baseUrl ?? openAiMetadata.baseUrl;
  const metadata = { ...deps.identity, baseUrl };
  return withProviderLogging(
    createOpenAiProviderCore(deps, metadata),
    deps.logger,
  );
};

export const createOpenAiProviderCore = (
  deps: Omit<OpenAiProviderDeps, 'logger'>,
  metadata: ProviderMetadata = openAiMetadata,
): LlmProvider => {
  const baseUrl = deps.baseUrl ?? metadata.baseUrl;
  const providerId = metadata.id;
  const providerName = metadata.name;

  const send = async (
    request: ProviderRequest<unknown>,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const auth = await authorization(deps, providerId, providerName);
    const sensitiveOutput = request.flags?.sensitiveOutput === true;

    const response = await deps.transport.request({
      method: 'POST',
      url: `${baseUrl}/responses`,
      headers: {
        ...(auth === undefined ? {} : { authorization: auth }),
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
    const body = openAiBody(request, false, providerId);
    return parseStructuredOutput(
      providerId,
      request,
      parseFinished(await send(request, body)),
    );
  }

  return {
    metadata,
    capabilities: openAiCapabilities,

    complete,

    async *stream<Output = JsonValue>(
      request: ProviderRequest<Output>,
    ): AsyncIterable<ProviderStreamEvent<Output>> {
      requireRequestInput(providerId, request);
      const sensitiveOutput = request.flags?.sensitiveOutput === true;
      const body = openAiBody(request, true, providerId);
      const text: string[] = [];
      const reasoning: string[] = [];
      const refusals: string[] = [];
      const textSnapshots = createTextSnapshots();
      const calls = new Map<number, ProviderToolCall>();
      const auth = await authorization(deps, providerId, providerName);

      yield {
        type: 'response.started',
        provider: providerId,
        model: body.model as string,
      };

      for await (const event of parseSseEvents(
        deps.transport.stream({
          method: 'POST',
          url: `${baseUrl}/responses`,
          headers: {
            ...(auth === undefined ? {} : { authorization: auth }),
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: request.signal,
        }),
      )) {
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

        const parsed = streamEvent(payload, calls);
        recordTextSnapshot(textSnapshots, payload);

        if (parsed?.type === 'text.delta') {
          text.push(parsed.delta);
        }

        if (parsed?.type === 'reasoning.delta') {
          reasoning.push(parsed.delta);
        }

        if (parsed?.type === 'refusal.delta') {
          refusals.push(parsed.delta);
        }

        if (parsed !== undefined) {
          yield parsed;
        }

        if (payload.type === 'response.completed') {
          const response = recordField(payload, 'response') ?? payload;
          const finish = parseStructuredOutput(
            providerId,
            request,
            parseFinished(
              response,
              streamText(text, textSnapshots),
              reasoning.join(''),
              refusals.join('') || undefined,
              [...calls.values()],
            ),
            false,
          );
          const usage = finish.usage;

          if (usage !== undefined) {
            yield { type: 'usage', usage };
          }

          yield { type: 'response.finished', finish };
          return;
        }

        if (payload.type === 'response.failed') {
          yield streamErrorEvent(
            providerId,
            'provider_error',
            `${providerName} stream failed.`,
            undefined,
            sensitiveOutput,
          );
          return;
        }
      }

      yield {
        type: 'response.finished',
        finish: parseStructuredOutput(
          providerId,
          request,
          {
            text: streamText(text, textSnapshots) ?? '',
            reasoning: { text: reasoning.join('') },
            refusal: refusals.join('') || undefined,
            finishReason: 'unknown',
            toolCalls: [...calls.values()],
          },
          false,
        ),
      };
    },

    async embedding(
      request: ProviderEmbeddingRequest,
    ): Promise<ProviderEmbeddingFinished> {
      requireEmbeddingInput(providerId, request);
      const auth = await authorization(deps, providerId, providerName);
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
          ...(auth === undefined ? {} : { authorization: auth }),
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
      );
    },

    async rerank(
      request: ProviderRerankRequest,
    ): Promise<ProviderRerankFinished> {
      requireRerankInput(providerId, request);
      const auth = await authorization(deps, providerId, providerName);
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
          ...(auth === undefined ? {} : { authorization: auth }),
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
      );
    },

    async models(signal?: AbortSignal): Promise<readonly Model[]> {
      const auth = await authorization(deps, providerId, providerName);
      const response = await deps.transport.request({
        method: 'GET',
        url: `${baseUrl}/models`,
        headers: {
          ...(auth === undefined ? {} : { authorization: auth }),
          accept: 'application/json',
        },
        signal,
      });

      if (response.status >= 400) {
        throw httpError(providerId, response.status, response.body);
      }

      return arrayField(parseJsonBody(providerId, response.body), 'data')
        .map(asRecord)
        .filter(
          (model): model is Record<string, unknown> => model !== undefined,
        )
        .map((model) => ({
          id: stringField(model, 'id') ?? '',
          name: stringField(model, 'id'),
          provider: providerId,
          raw: model,
        }))
        .filter((model) => model.id !== '');
    },

    async validateModel(model: string, signal?: AbortSignal): Promise<Model> {
      const found = (await this.models(signal)).find(
        (item) => item.id === model,
      );

      if (found === undefined) {
        throw new ProviderErrorObject({
          provider: providerId,
          code: 'missing_model',
          message: `${providerName} model is not available: ${model}`,
        });
      }

      return found;
    },
  };
};
