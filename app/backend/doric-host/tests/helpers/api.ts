import assert from 'node:assert/strict';

/*
 * The public API as a client outside the host reaches it: the Connect
 * protocol with JSON over HTTP/1.1 on the public listener (spec section 11,
 * "The routes"). Only `fetch`, so the host package needs no new dependency.
 * The procedure path is `/<package>.<Service>/<Method>`, as
 * `doric.api.status.v1.StatusService/Watch`.
 */

/** A Connect error answered by the gateway: its code and `ErrorInfo` reason. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(`${String(status)} ${code}: ${JSON.stringify(body)}`);
    this.name = 'ApiError';
  }
}

const headers = {
  'connect-protocol-version': '1',
} as const;

/** One unary call; resolves with the JSON answer, rejects with an {@link ApiError}. */
export const callApi = async <T = Record<string, unknown>>(
  baseUrl: string,
  procedure: string,
  request: unknown = {},
): Promise<T> => {
  const response = await fetch(`${baseUrl}/${procedure}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (body as { code?: string } | undefined)?.code ?? 'unknown',
      body,
    );
  }

  return body as T;
};

/** A Connect envelope: one flag byte, a big-endian length, the JSON message. */
const envelope = (message: unknown): Uint8Array => {
  const data = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(5 + data.length);

  new DataView(frame.buffer).setUint32(1, data.length);
  frame.set(data, 5);
  return frame;
};

/**
 * Opens a server stream and resolves with its first message, then cancels
 * the stream. Rejects with an {@link ApiError} when the stream answers an
 * error before any message, or when it ends without one.
 */
export const firstStreamItem = async <T = Record<string, unknown>>(
  baseUrl: string,
  procedure: string,
  request: unknown = {},
): Promise<T> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);

  try {
    const response = await fetch(`${baseUrl}/${procedure}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/connect+json' },
      body: envelope(request),
      signal: abort.signal,
    });

    if (!response.ok || response.body === null) {
      const body = (await response.json().catch(() => undefined)) as unknown;
      throw new ApiError(
        response.status,
        (body as { code?: string } | undefined)?.code ?? 'unknown',
        body,
      );
    }

    const reader = response.body.getReader();
    let buffered = new Uint8Array(0);

    for (;;) {
      if (buffered.length >= 5) {
        const view = new DataView(
          buffered.buffer,
          buffered.byteOffset,
          buffered.byteLength,
        );
        const flags = view.getUint8(0);
        const length = view.getUint32(1);

        if (buffered.length >= 5 + length) {
          const message = JSON.parse(
            new TextDecoder().decode(buffered.subarray(5, 5 + length)),
          ) as unknown;

          if ((flags & 0b10) !== 0) {
            // The end-of-stream message: an error, or an end with no item.
            const error = (message as { error?: { code?: string } }).error;
            throw new ApiError(200, error?.code ?? 'no_item', message);
          }

          await reader.cancel().catch(() => undefined);
          return message as T;
        }
      }

      const { done, value } = await reader.read();

      assert.ok(!done, `${procedure} ended before its first message`);
      const next = new Uint8Array(buffered.length + value.length);
      next.set(buffered);
      next.set(value, buffered.length);
      buffered = next;
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
};
