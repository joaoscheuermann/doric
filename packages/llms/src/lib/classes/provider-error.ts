import type { ProviderError } from '../types/provider.js';

/** Error wrapper used only when provider failures need normal thrown semantics. */
export class ProviderErrorObject extends Error {
  readonly data: ProviderError;

  constructor(data: ProviderError, options?: ErrorOptions) {
    super(data.message, options);

    this.name = 'ProviderError';

    this.data = data;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
