import pino, { type Logger } from 'pino';

import type {
  HttpRequest,
  HttpResponse,
  HttpStreamChunk,
  HttpTransport,
} from '../src/index.js';
import {
  type CodexProviderDeps,
  createCodexProvider as createCodexProviderBase,
  createLmStudioOpenAiProvider as createLmStudioOpenAiProviderBase,
  createLmStudioProvider as createLmStudioProviderBase,
  createOpenAiProvider as createOpenAiProviderBase,
  createOpenRouterProvider as createOpenRouterProviderBase,
  createUnifiedProvider as createUnifiedProviderBase,
  type LmStudioOpenAiProviderDeps,
  type LmStudioProviderDeps,
  type OpenAiProviderDeps,
  type OpenRouterProviderDeps,
  type UnifiedProviderDeps,
} from '../src/index.js';

type TestDeps<Deps extends { readonly logger: Logger }> = Omit<
  Deps,
  'logger'
> & { readonly logger?: Logger };

export const silentLogger = pino({ enabled: false });

export const createOpenAiProvider = (deps: TestDeps<OpenAiProviderDeps>) =>
  createOpenAiProviderBase({ ...deps, logger: deps.logger ?? silentLogger });

export const createOpenRouterProvider = (
  deps: TestDeps<OpenRouterProviderDeps>,
) =>
  createOpenRouterProviderBase({
    ...deps,
    logger: deps.logger ?? silentLogger,
  });

export const createUnifiedProvider = (deps: TestDeps<UnifiedProviderDeps>) =>
  createUnifiedProviderBase({
    ...deps,
    logger: deps.logger ?? silentLogger,
  });

export const createLmStudioProvider = (deps: TestDeps<LmStudioProviderDeps>) =>
  createLmStudioProviderBase({ ...deps, logger: deps.logger ?? silentLogger });

export const createLmStudioOpenAiProvider = (
  deps: TestDeps<LmStudioOpenAiProviderDeps>,
) =>
  createLmStudioOpenAiProviderBase({
    ...deps,
    logger: deps.logger ?? silentLogger,
  });

export const createCodexProvider = (deps: TestDeps<CodexProviderDeps>) =>
  createCodexProviderBase({ ...deps, logger: deps.logger ?? silentLogger });

export type FakeTransport = HttpTransport & {
  readonly requests: readonly HttpRequest[];
};

export const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

export const fakeTransport = (options: {
  readonly responses?: readonly HttpResponse[];
  readonly streams?: readonly (readonly HttpStreamChunk[])[];
}): FakeTransport => {
  const requests: HttpRequest[] = [];
  const responses = [...(options.responses ?? [])];
  const streams = [...(options.streams ?? [])];

  return {
    requests,

    async request(request: HttpRequest): Promise<HttpResponse> {
      requests.push(request);

      const next = responses.shift();

      if (next === undefined) {
        throw new Error('Fake transport response was not configured.');
      }

      return next;
    },

    async *stream(request: HttpRequest): AsyncIterable<HttpStreamChunk> {
      requests.push(request);

      const next = streams.shift();

      if (next === undefined) {
        throw new Error('Fake transport stream was not configured.');
      }

      yield* next;
    },
  };
};

export const collect = async <T>(
  items: AsyncIterable<T>,
): Promise<readonly T[]> => {
  const collected: T[] = [];

  for await (const item of items) {
    collected.push(item);
  }

  return collected;
};
