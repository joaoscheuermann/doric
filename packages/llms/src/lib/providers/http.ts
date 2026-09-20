import { HttpStreamError } from '../classes/http-error.js';
import { ProviderErrorObject } from '../classes/provider-error.js';
import type { HttpRequest, HttpTransport } from '../types/http.js';
import type { ProviderId } from '../types/provider.js';
import { httpError, parseJsonBody } from './common.js';

/** Sends a JSON request using the same status and parsing rules for every adapter. */
export const requestJson = async (
  transport: HttpTransport,
  provider: ProviderId,
  request: HttpRequest,
): Promise<Record<string, unknown>> => {
  const response = await transport.request(request);
  if (response.status >= 400) {
    throw httpError(provider, response.status, response.body);
  }
  return parseJsonBody(provider, response.body);
};

/** Attaches provider identity to transport failures without changing cancellation. */
export const withProviderErrors = (
  transport: HttpTransport,
  provider: ProviderId,
): HttpTransport => ({
  async request(request) {
    try {
      return await transport.request(request);
    } catch (error) {
      throw transportError(provider, error, request.signal);
    }
  },
  async *stream(request) {
    try {
      yield* transport.stream(request);
    } catch (error) {
      throw transportError(provider, error, request.signal);
    }
  },
});

const transportError = (
  provider: ProviderId,
  error: unknown,
  signal: AbortSignal | undefined,
): unknown => {
  if (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError') ||
    error instanceof ProviderErrorObject
  ) {
    return error;
  }

  if (error instanceof HttpStreamError) {
    const failure = httpError(provider, error.status, error.diagnostic);
    return new ProviderErrorObject(
      { ...failure.data, diagnostic: error.diagnostic },
      { cause: error },
    );
  }

  return error;
};
