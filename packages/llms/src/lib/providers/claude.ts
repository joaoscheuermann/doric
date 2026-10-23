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
  ProviderRerankFinished,
  ProviderRerankRequest,
  ProviderStreamEvent,
  ProviderStructuredFinished,
  StructuredOutputSchema,
  StructuredOutputValue,
} from '../types/provider.js';
import { arrayField, asRecord, stringField } from '../utils/json.js';
import { parseSseEvents } from '../utils/sse.js';
import type { SecretSource } from './auth.js';
import { claudeBody } from './claude/body.js';
import {
  claudeStreamEvents,
  claudeStreamFinish,
  createClaudeStreamState,
  isClaudeStreamError,
  parseClaudeFinished,
} from './claude/parse.js';
import {
  parseJsonBody,
  requireRequestInput,
  streamErrorEvent,
} from './common.js';
import { requestJson, withProviderErrors } from './http.js';
import { withProviderLogging } from './logging.js';
import { parseStructuredOutput } from './structured.js';

/** The user agent Claude Code's CLI sends, so a subscription login is read as one. */
export const claudeUserAgent = 'claude-cli/2.1.309 (external, cli)';

export interface ClaudeProviderDeps {
  readonly transport: HttpTransport;
  readonly authorization: SecretSource;
  readonly baseUrl?: string;
  readonly logger: Logger;
  /**
   * Accepted for kind-builder symmetry; Claude is always its own identity, so
   * a configured provider still answers `claude`.
   */
  readonly identity?: { readonly id: string; readonly name: string };
}

export const claudeMetadata: ProviderMetadata = {
  id: 'claude',
  name: 'Claude',
  baseUrl: 'https://api.anthropic.com',
};

export const claudeCapabilities: ProviderCapabilities = {
  streaming: true,
  embeddings: false,
  reranking: false,
  tools: true,
  reasoning: false,
  modelListing: true,
  oauth: true,
  serviceTier: false,
  structuredOutputs: false,
};

/** Creates a Claude Code provider over Anthropic's Messages API. */
export const createClaudeProvider = (deps: ClaudeProviderDeps): LlmProvider => {
  const baseUrl = deps.baseUrl ?? claudeMetadata.baseUrl;
  const metadata = { ...claudeMetadata, baseUrl };
  const providerId = metadata.id;
  const providerName = metadata.name;
  const transport = withProviderErrors(deps.transport, providerId);

  const headers = async (): Promise<Record<string, string>> => ({
    authorization: await claudeAuthorization(deps),
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
    'x-app': 'cli',
    'user-agent': claudeUserAgent,
  });

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
    const body = claudeBody(request, false, providerId);
    const response = await requestJson(transport, providerId, {
      method: 'POST',
      url: `${baseUrl}/v1/messages?beta=true`,
      headers: {
        ...(await headers()),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    return parseStructuredOutput(
      providerId,
      request,
      parseClaudeFinished(response),
    );
  }

  return withProviderLogging(
    {
      metadata,
      capabilities: claudeCapabilities,

      complete,

      async *stream<Output = JsonValue>(
        request: ProviderRequest<Output>,
      ): AsyncIterable<ProviderStreamEvent<Output>> {
        requireRequestInput(providerId, request);
        const body = claudeBody(request, true, providerId);
        const state = createClaudeStreamState();

        yield {
          type: 'response.started',
          provider: providerId,
          model: body.model as string,
        };

        for await (const event of parseSseEvents(
          transport.stream({
            method: 'POST',
            url: `${baseUrl}/v1/messages?beta=true`,
            headers: {
              ...(await headers()),
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

          if (isClaudeStreamError(payload)) {
            yield streamErrorEvent(
              providerId,
              'provider_error',
              `${providerName} stream error.`,
              event.data,
            );
            return;
          }

          for (const parsed of claudeStreamEvents(payload, state)) {
            yield parsed;
          }

          if (stringField(payload, 'type') === 'message_stop') {
            yield {
              type: 'response.finished',
              finish: parseStructuredOutput(
                providerId,
                request,
                claudeStreamFinish(state),
                false,
              ),
            };
            return;
          }
        }

        yield {
          type: 'response.finished',
          finish: parseStructuredOutput(
            providerId,
            request,
            claudeStreamFinish(state),
            false,
          ),
        };
      },

      embedding(
        _request: ProviderEmbeddingRequest,
      ): Promise<ProviderEmbeddingFinished> {
        return Promise.reject(
          new ProviderErrorObject({
            provider: providerId,
            code: 'unsupported_embeddings',
            message: 'Claude provider does not support embeddings.',
          }),
        );
      },

      rerank(_request: ProviderRerankRequest): Promise<ProviderRerankFinished> {
        return Promise.reject(
          new ProviderErrorObject({
            provider: providerId,
            code: 'unsupported_reranking',
            message: 'Claude provider does not support reranking.',
          }),
        );
      },

      async models(signal?: AbortSignal): Promise<readonly Model[]> {
        const response = await requestJson(transport, providerId, {
          method: 'GET',
          url: `${baseUrl}/v1/models?beta=true`,
          headers: {
            ...(await headers()),
            accept: 'application/json',
          },
          signal,
        });

        return arrayField(response, 'data')
          .map(asRecord)
          .filter(
            (model): model is Record<string, unknown> => model !== undefined,
          )
          .map((model) => ({
            id: stringField(model, 'id') ?? '',
            name: stringField(model, 'display_name'),
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
    },
    deps.logger,
  );
};

/**
 * The stored authorization value, verbatim: a Claude login already carries its
 * `Bearer` scheme, so nothing here adds one.
 */
const claudeAuthorization = async (
  deps: ClaudeProviderDeps,
): Promise<string> => {
  const value =
    typeof deps.authorization === 'function'
      ? await deps.authorization()
      : deps.authorization;

  if (value.trim() === '') {
    throw new ProviderErrorObject({
      provider: 'claude',
      code: 'auth_missing',
      message: 'Claude provider received an empty auth value.',
    });
  }

  return value;
};
