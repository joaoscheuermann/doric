import type { HttpRequest, HttpResponse, HttpTransport } from './types/http.js';
import { HttpStreamError } from './classes/http-error.js';

const headersToRecord = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

/** Creates a production transport around Fetch while keeping providers testable. */
export const createFetchTransport = (
  fetcher: typeof fetch = fetch,
): HttpTransport => ({
  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });

    return {
      status: response.status,
      headers: headersToRecord(response.headers),
      body: await response.text(),
    };
  },

  async *stream(request: HttpRequest): AsyncIterable<Uint8Array> {
    const response = await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });

    if (!response.ok) {
      throw new HttpStreamError(response.status, await response.text());
    }

    if (response.body === null) {
      return;
    }

    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      yield chunk;
    }
  },
});
