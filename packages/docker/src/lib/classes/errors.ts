export type DockerHttpErrorData = {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;
};

export class DockerHttpError extends Error {
  readonly body: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;

  constructor(data: DockerHttpErrorData) {
    super(`Docker ${data.method} ${data.path} failed with HTTP ${data.status}`);

    this.name = 'DockerHttpError';

    this.status = data.status;

    this.method = data.method;

    this.path = data.path;

    this.body = data.body;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DockerRequestTimeoutError extends Error {
  readonly method: string;
  readonly path: string;
  readonly timeoutMs: number;

  constructor(method: string, path: string, timeoutMs: number) {
    super(`Docker ${method} ${path} timed out after ${timeoutMs}ms`);

    this.name = 'DockerRequestTimeoutError';

    this.method = method;

    this.path = path;

    this.timeoutMs = timeoutMs;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DockerRequestAbortedError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string) {
    super(`Docker ${method} ${path} was aborted`);

    this.name = 'DockerRequestAbortedError';

    this.method = method;

    this.path = path;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DockerProtocolError extends Error {
  constructor(message: string) {
    super(message);

    this.name = 'DockerProtocolError';

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
