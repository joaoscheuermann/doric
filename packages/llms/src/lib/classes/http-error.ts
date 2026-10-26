import { diagnosticExcerpt } from '../utils/diagnostics.js';

/** A rejected HTTP stream, before a provider identity is attached. */
export class HttpStreamError extends Error {
  readonly status: number;
  readonly diagnostic: string;
  /** The response headers, so a provider can read `retry-after` or a request id. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    body: string,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(`HTTP ${status} while opening provider stream.`);
    this.name = 'HttpStreamError';
    this.status = status;
    this.diagnostic = diagnosticExcerpt(body);
    this.headers = headers;
  }
}
