export type OAuthHttpMethod = 'GET' | 'POST';

export type OAuthHttpHeaders = Readonly<Record<string, string>>;

export interface OAuthHttpRequest {
  readonly method: OAuthHttpMethod;
  readonly url: string;
  readonly headers?: OAuthHttpHeaders;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface OAuthHttpResponse {
  readonly status: number;
  readonly headers: OAuthHttpHeaders;
  readonly body: string;
}

/** Boundary for OAuth HTTP calls; callers and tests inject the concrete transport. */
export interface OAuthTransport {
  request(request: OAuthHttpRequest): Promise<OAuthHttpResponse>;
}

const headersToRecord = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

/**
 * Creates an OAuth transport around Fetch while keeping token calls testable.
 *
 * Tolerated duplication: `llms` owns a near-identical `createFetchTransport`
 * (plus streaming) but this package depends on nothing beyond `tslib`, so
 * sharing would cost a new package or a cross-package dependency. Extract only
 * when a third consumer appears (see `packages/AGENTS.md`).
 */
export const createFetchTransport = (
  fetcher: typeof fetch = fetch,
): OAuthTransport => ({
  async request(request: OAuthHttpRequest): Promise<OAuthHttpResponse> {
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
});
