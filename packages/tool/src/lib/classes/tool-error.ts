import type { ToolError } from '../types/tool.js';

/** Structured error thrown for tool registration, parsing, validation, and execution failures. */
export class ToolErrorObject extends Error {
  readonly data: ToolError;

  constructor(data: ToolError, options?: ErrorOptions) {
    super(data.message, options);

    this.name = 'ToolErrorObject';

    this.data = data;
  }
}
