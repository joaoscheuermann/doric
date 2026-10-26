import type { Logger } from 'pino';

import { HttpStreamError } from '../classes/http-error.js';
import { ProviderErrorObject } from '../classes/provider-error.js';
import type { HttpRequest, HttpTransport } from '../types/http.js';
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
import { diagnosticExcerpt } from '../utils/diagnostics.js';
import {
  arrayField,
  asRecord,
  numberField,
  stringField,
} from '../utils/json.js';
import { parseSseEvents } from '../utils/sse.js';
import type { SecretSource } from './auth.js';
import { claudeBody, claudeBodyBetas } from './claude/body.js';
import { undatedModelId } from './claude/models.js';
import {
  claudeErrorOf,
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
import { withProviderErrors } from './http.js';
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
  reasoning: true,
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
  const transport = withProviderErrors(
    withClaudeErrors(deps.transport, providerId),
    providerId,
  );

  const headers = async (
    betas: readonly string[] = [],
  ): Promise<Record<string, string>> => ({
    ...(await claudeAuthHeaders(deps)),
    'anthropic-version': '2023-06-01',
    'anthropic-beta': [...claudeBetas, ...betas].join(','),
    'x-app': 'cli',
    'user-agent': claudeUserAgent,
  });

  /** A JSON request; a refusal answers with Anthropic's own error message. */
  const requestJson = async (
    request: HttpRequest,
  ): Promise<Record<string, unknown>> => {
    const response = await transport.request(request);
    if (response.status >= 400) {
      throw claudeHttpError(
        providerId,
        response.status,
        response.body,
        response.headers,
      );
    }
    return parseJsonBody(providerId, response.body);
  };

  /** Every model the catalog lists, page by page. */
  const listModels = async (
    signal?: AbortSignal,
  ): Promise<readonly Model[]> => {
    const models: Model[] = [];
    let after: string | undefined;

    do {
      const page = await requestJson({
        method: 'GET',
        url: `${baseUrl}/v1/models?beta=true&limit=1000${
          after === undefined ? '' : `&after_id=${encodeURIComponent(after)}`
        }`,
        headers: { ...(await headers()), accept: 'application/json' },
        signal,
      });
      const listed = arrayField(page, 'data')
        .map(asRecord)
        .filter(
          (model): model is Record<string, unknown> => model !== undefined,
        )
        .map((model) => claudeModel(model, providerId))
        .filter((model) => model.id !== '');
      models.push(...listed);
      after =
        page.has_more === true
          ? (stringField(page, 'last_id') ?? listed.at(-1)?.id)
          : undefined;
    } while (after !== undefined);

    return models;
  };

  /**
   * The catalog this provider read once, for the context window a stream
   * reports. A listing that fails reads as no catalog: a request never fails
   * because the window could not be looked up.
   */
  let catalog: Promise<readonly Model[]> | undefined;
  const contextWindowOf = async (
    model: string,
  ): Promise<number | undefined> => {
    catalog ??= listModels().catch(() => []);
    return findModel(await catalog, model)?.contextWindow;
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
    const body = claudeBody(request, false, providerId);
    const response = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v1/messages?beta=true`,
      headers: {
        ...(await headers(claudeBodyBetas(body))),
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
        const contextWindow = await contextWindowOf(request.model);

        yield {
          type: 'response.started',
          provider: providerId,
          model: body.model as string,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        };

        for await (const event of parseSseEvents(
          transport.stream({
            method: 'POST',
            url: `${baseUrl}/v1/messages?beta=true`,
            headers: {
              ...(await headers(claudeBodyBetas(body))),
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
            const error = claudeErrorOf(payload);
            yield {
              type: 'error',
              error: {
                provider: providerId,
                code: error.type ?? 'provider_error',
                message: `${providerName} stream error${
                  error.type === undefined ? '' : ` (${error.type})`
                }${error.message === undefined ? '.' : `: ${error.message}`}`,
                retryable: error.retryable,
                diagnostic: diagnosticExcerpt(event.data),
              },
            };
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

        // A stream that ends without `message_stop` was cut short: what it
        // carried is not an answer, and a retry may complete it.
        yield {
          type: 'error',
          error: {
            ...streamErrorEvent(
              providerId,
              'incomplete_stream',
              `${providerName} stream ended before the response finished.`,
            ).error,
            retryable: true,
          },
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

      models(signal?: AbortSignal): Promise<readonly Model[]> {
        return listModels(signal);
      },

      async validateModel(model: string, signal?: AbortSignal): Promise<Model> {
        const found = findModel(await listModels(signal), model);

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

/** The betas every request carries: the OAuth login and Claude Code's own. */
const claudeBetas = ['oauth-2025-04-20', 'claude-code-20250219'] as const;

/**
 * The auth header a stored value is sent as: a Console API key
 * (`sk-ant-api…`) as `x-api-key`, a value that already names its `Bearer`
 * scheme as it is, and any other token (a `claude setup-token` value, a bare
 * access token) under `Bearer`.
 */
const claudeAuthHeaders = async (
  deps: ClaudeProviderDeps,
): Promise<Record<string, string>> => {
  const raw =
    typeof deps.authorization === 'function'
      ? await deps.authorization()
      : deps.authorization;
  const value = raw.trim();

  if (value === '') {
    throw new ProviderErrorObject({
      provider: 'claude',
      code: 'auth_missing',
      message: 'Claude provider received an empty auth value.',
    });
  }

  if (/^bearer\s/i.test(value)) {
    return { authorization: value };
  }

  if (value.startsWith('sk-ant-api')) {
    return { 'x-api-key': value };
  }

  return { authorization: `Bearer ${value}` };
};

/** A catalog entry as a model, its context window read from `max_input_tokens`. */
const claudeModel = (
  model: Record<string, unknown>,
  provider: string,
): Model => {
  const contextWindow = numberField(model, 'max_input_tokens');
  return {
    id: stringField(model, 'id') ?? '',
    name: stringField(model, 'display_name'),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    provider,
    raw: model,
  };
};

/**
 * The listed model an id names: the exact id, else the same model with or
 * without its date (`claude-haiku-4-5` and `claude-haiku-4-5-20251001`).
 */
const findModel = (
  models: readonly Model[],
  model: string,
): Model | undefined =>
  models.find((item) => item.id === model) ??
  models.find((item) => undatedModelId(item.id) === undatedModelId(model));

/** `retry-after` in milliseconds: seconds, or an HTTP date. */
const retryAfterMs = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

/** A header by case-insensitive name. */
const header = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];

/**
 * A refused request as the provider error it is, with Anthropic's own message
 * in it (`prompt is too long: …` is what a context-overflow check reads), the
 * wait `retry-after` asks for and the request id. A spend cap is never
 * retryable, however long a retry waits.
 */
export const claudeHttpError = (
  provider: string,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): ProviderErrorObject => {
  let envelope: Record<string, unknown> = {};
  try {
    envelope = asRecord(JSON.parse(body)) ?? {};
  } catch {
    // A body that is not Anthropic's error envelope keeps the bare status.
  }
  const error = claudeErrorOf(envelope);
  const wait = retryAfterMs(header(headers, 'retry-after'));
  const requestId =
    header(headers, 'request-id') ?? stringField(envelope, 'request_id');
  const hint =
    status === 401 ? ' Sign in with Claude again to renew the login.' : '';

  return new ProviderErrorObject({
    provider,
    code: status === 401 || status === 403 ? 'auth_failed' : 'http_error',
    message: `${provider} request failed with HTTP ${status}${
      error.message === undefined ? '.' : `: ${error.message}`
    }${hint}`,
    status,
    retryable:
      (status === 429 || status >= 500) &&
      error.code !== 'enforced_spend_limit_reached',
    diagnostic: diagnosticExcerpt(body),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(requestId === undefined ? {} : { requestId }),
  });
};

/**
 * A transport whose rejected streams fail as Claude's own errors, so a stream
 * that is refused before it opens says what Anthropic said.
 */
const withClaudeErrors = (
  transport: HttpTransport,
  provider: string,
): HttpTransport => ({
  request: (request) => transport.request(request),
  async *stream(request) {
    try {
      yield* transport.stream(request);
    } catch (error) {
      if (error instanceof HttpStreamError) {
        throw claudeHttpError(
          provider,
          error.status,
          error.diagnostic,
          error.headers,
        );
      }
      throw error;
    }
  },
});
