import { diagnosticExcerpt } from '../utils/diagnostics.js';

/** A rejected HTTP stream, before a provider identity is attached. */
export class HttpStreamError extends Error {
  readonly status: number;
  readonly diagnostic: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status} while opening provider stream.`);
    this.name = 'HttpStreamError';
    this.status = status;
    this.diagnostic = diagnosticExcerpt(body);
  }
}
