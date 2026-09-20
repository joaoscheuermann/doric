import type { ConfigParseErrorCode } from '../types/error.js';

export class ConfigParseError extends TypeError {
  readonly code: ConfigParseErrorCode;
  readonly path: string;

  constructor(code: ConfigParseErrorCode, path: string, message: string) {
    super(message);

    this.name = 'ConfigParseError';

    this.code = code;

    this.path = path;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
