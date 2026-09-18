import type { OAuthError } from '../types/oauth.js';

/** Error wrapper used when OAuth failures need normal thrown semantics. */
export class OAuthErrorObject extends Error {
  readonly data: OAuthError;

  constructor(data: OAuthError, options?: ErrorOptions) {
    super(data.message, options);

    this.name = 'OAuthError';

    this.data = data;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
