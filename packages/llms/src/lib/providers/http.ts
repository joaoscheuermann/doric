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

/** Transport codes of a connection that could not be made or was dropped. */
const networkCodes = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'EAI_AGAIN',
]);

/**
 * Whether a transport failure, or one of its causes up to eight levels deep,
 * carries a connection code. The code is read by shape: undici puts it on a
 * plain cause object, not on an `Error`.
 */
const networkFailure = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth <= 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === 'string' && networkCodes.has(code)) return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
};

/**
 * The provider failure a transport failure stands for. Cancellations and
 * provider errors pass through; a failed stream becomes the HTTP error of its
 * status; a connection that could not be made or dropped becomes a retryable
 * `network_error` whose cause is the transport failure; anything else, such
 * as an unresolvable host, passes through unchanged.
 */
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

  if (networkFailure(error)) {
    return new ProviderErrorObject(
      {
        provider,
        code: 'network_error',
        message: `Could not connect to ${provider}.`,
        retryable: true,
      },
      { cause: error },
    );
  }

  return error;
};
