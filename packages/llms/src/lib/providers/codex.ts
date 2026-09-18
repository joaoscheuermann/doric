import type { Logger } from 'pino';

import { ProviderErrorObject } from '../classes/provider-error.js';
import type { HttpTransport } from '../types/http.js';
import type {
  JsonValue,
  LlmProvider,
  ProviderCapabilities,
  ProviderEmbeddingFinished,
  ProviderEmbeddingRequest,
  ProviderFinished,
  ProviderMetadata,
  ProviderRequest,
  ProviderRerankRequest,
  ProviderRerankFinished,
  ProviderStructuredFinished,
  StructuredOutputSchema,
  StructuredOutputValue,
} from '../types/provider.js';
import { parseStructuredOutput } from './structured.js';
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
  const openai = createOpenAiProviderCore(
    {
      transport: deps.transport,
      authorization: deps.authorization,
      baseUrl: deps.baseUrl ?? codexBaseUrl,
    },
    codexMetadata,
    { body: codexBody, headers: () => codexHeaders(deps) },
  );

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
    for await (const event of openai.stream(request)) {
      if (event.type === 'response.finished') {
        return parseStructuredOutput('codex', request, event.finish);
      }

      if (event.type === 'error') {
        throw new ProviderErrorObject(event.error);
      }
    }

    throw new ProviderErrorObject({
      provider: 'codex',
      code: 'missing_stream_finish',
      message: 'Codex stream ended before a final response.',
    });
  }

  return withProviderLogging(
    {
      ...openai,
      metadata: codexMetadata,
      capabilities: codexCapabilities,

      complete,

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
    },
    deps.logger,
  );
};

const codexBody = (body: Record<string, unknown>): Record<string, unknown> => {
  const supported = { ...body };
  delete supported.temperature;

  return {
    ...supported,
    instructions: codexInstructions(body.instructions),
    store: false,
  };
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
