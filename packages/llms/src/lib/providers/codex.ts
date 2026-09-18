import type { Logger } from 'pino';

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
  ProviderRerankRequest,
  ProviderRerankFinished,
  ProviderStructuredFinished,
  ProviderStreamEvent,
  StructuredOutputSchema,
  StructuredOutputValue,
} from '../types/provider.js';
import { parseStructuredOutput } from './common.js';
import { withProviderLogging } from './logging.js';
import { createOpenAiProviderCore, type SecretSource } from './openai.js';

const codexBaseUrl = 'https://chatgpt.com/backend-api/codex';
const codexDefaultInstructions = 'You are Codex, a coding agent.';

export type CodexProviderDeps = {
  readonly transport: HttpTransport;
  readonly authorization: SecretSource;
  readonly chatGptAccountId?: SecretSource;
  readonly fedramp?: boolean;
  readonly baseUrl?: string;
  readonly logger: Logger;
};

export const codexMetadata: ProviderMetadata = {
  id: 'codex',
  name: 'Codex',
  baseUrl: codexBaseUrl,
};

export const codexCapabilities: ProviderCapabilities = {
  streaming: true,
  embeddings: false,
  reranking: false,
  tools: true,
  reasoning: true,
  modelListing: true,
  oauth: true,
  serviceTier: true,
  structuredOutputs: true,
};

/** Creates a Codex-authenticated provider over ChatGPT's Codex Responses API. */
export const createCodexProvider = (deps: CodexProviderDeps): LlmProvider => {
  const openai = createOpenAiProviderCore({
    transport: withCodexHeaders(deps.transport, deps),
    authorization: deps.authorization,
    baseUrl: deps.baseUrl ?? codexBaseUrl,
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
    try {
      for await (const event of openai.stream(request)) {
        const mapped = codexEvent(event);

        if (mapped.type === 'response.finished') {
          return parseStructuredOutput('codex', request, mapped.finish);
        }

        if (mapped.type === 'error') {
          throw new ProviderErrorObject(mapped.error);
        }
      }

      throw new ProviderErrorObject({
        provider: 'codex',
        code: 'missing_stream_finish',
        message: 'Codex stream ended before a final response.',
      });
    } catch (error) {
      throw codexError(error);
    }
  }

  return withProviderLogging(
    {
      ...openai,
      metadata: codexMetadata,
      capabilities: codexCapabilities,

      complete,

      async *stream<Output = JsonValue>(
        request: ProviderRequest<Output>,
      ): AsyncIterable<ProviderStreamEvent<Output>> {
        try {
          for await (const event of openai.stream(request)) {
            yield codexEvent(event);
          }
        } catch (error) {
          throw codexError(error);
        }
      },

      async embedding(
        _request: ProviderEmbeddingRequest,
      ): Promise<ProviderEmbeddingFinished> {
        throw new ProviderErrorObject({
          provider: 'codex',
          code: 'unsupported_embeddings',
          message: 'Codex provider does not support embeddings.',
        });
      },

      async rerank(
        _request: ProviderRerankRequest,
      ): Promise<ProviderRerankFinished> {
        throw new ProviderErrorObject({
          provider: 'codex',
          code: 'unsupported_reranking',
          message: 'Codex provider does not support reranking.',
        });
      },

      async models(signal?: AbortSignal): Promise<readonly Model[]> {
        try {
          return (await openai.models(signal)).map((model) => ({
            ...model,
            provider: 'codex',
          }));
        } catch (error) {
          throw codexError(error);
        }
      },

      async validateModel(model: string, signal?: AbortSignal): Promise<Model> {
        try {
          const found = await openai.validateModel(model, signal);

          return { ...found, provider: 'codex' };
        } catch (error) {
          throw codexError(error);
        }
      },
    },
    deps.logger,
  );
};

const withCodexHeaders = (
  transport: HttpTransport,
  deps: CodexProviderDeps,
): HttpTransport => ({
  async request(request) {
    return transport.request(await requestWithHeaders(request, deps));
  },

  stream(request) {
    return streamWithHeaders(transport, request, deps);
  },
});

async function* streamWithHeaders(
  transport: HttpTransport,
  request: HttpRequest,
  deps: CodexProviderDeps,
) {
  yield* transport.stream(await requestWithHeaders(request, deps));
}

const requestWithHeaders = async (
  request: HttpRequest,
  deps: CodexProviderDeps,
): Promise<HttpRequest> => ({
  ...request,
  body: codexBody(request.body),
  headers: {
    ...request.headers,
    ...(await codexHeaders(deps)),
  },
});

const codexBody = (body: string | undefined): string | undefined => {
  if (body === undefined) {
    return undefined;
  }

  const parsed = JSON.parse(body) as Record<string, unknown>;
  const supported = { ...parsed };
  delete supported.temperature;

  return JSON.stringify({
    ...supported,
    instructions: codexInstructions(parsed.instructions),
    store: false,
  });
};

const codexInstructions = (value: unknown): string =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : codexDefaultInstructions;

const codexHeaders = async (
  deps: CodexProviderDeps,
): Promise<Record<string, string>> => ({
  ...(deps.chatGptAccountId === undefined
    ? {}
    : { 'ChatGPT-Account-ID': await secret(deps.chatGptAccountId) }),
  ...(deps.fedramp === true ? { 'X-OpenAI-Fedramp': 'true' } : {}),
});

const codexEvent = <Output>(
  event: ProviderStreamEvent<Output>,
): ProviderStreamEvent<Output> => {
  if (event.type === 'response.started') {
    return { ...event, provider: 'codex' };
  }

  if (event.type === 'error') {
    return { ...event, error: { ...event.error, provider: 'codex' } };
  }

  return event;
};

const codexError = (error: unknown): unknown => {
  if (error instanceof ProviderErrorObject) {
    return new ProviderErrorObject({
      ...error.data,
      provider: 'codex',
    });
  }

  return error;
};

const secret = async (source: SecretSource): Promise<string> => {
  const value = typeof source === 'function' ? await source() : source;

  if (value.trim() === '') {
    throw new ProviderErrorObject({
      provider: 'codex',
      code: 'auth_missing',
      message: 'Codex provider received an empty auth value.',
    });
  }

  return value;
};
