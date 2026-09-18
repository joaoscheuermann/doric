export class JsonlParseError extends SyntaxError {
  readonly line: string;
  readonly lineNumber: number;
  readonly path: string;

  constructor(path: string, lineNumber: number, line: string, cause: unknown) {
    super(`Invalid JSONL at ${path}:${lineNumber}`, { cause });

    this.name = 'JsonlParseError';

    this.path = path;

    this.lineNumber = lineNumber;

    this.line = line;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
