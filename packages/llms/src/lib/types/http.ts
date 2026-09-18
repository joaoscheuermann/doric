export type HttpMethod = 'GET' | 'POST';

export type HttpHeaders = Readonly<Record<string, string>>;

export type HttpRequest = {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: HttpHeaders;
  readonly body?: string;
  readonly signal?: AbortSignal;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers: HttpHeaders;
  readonly body: string;
};

export type HttpStreamChunk = string | Uint8Array;

/** Boundary for provider HTTP calls; tests should inject fakes here. */
export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;

  stream(request: HttpRequest): AsyncIterable<HttpStreamChunk>;
}
