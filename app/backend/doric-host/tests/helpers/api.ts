import assert from 'node:assert/strict';

import { fromBinary } from '@bufbuild/protobuf';
import { ErrorInfoSchema } from 'bundle/contracts/gen/google/rpc/error_details_pb.js';

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

/**
 * An open server stream of the public API (Connect JSON envelopes over
 * `fetch`), read in order. Each item is the message's proto JSON.
 */
export interface ApiStream<T = Record<string, unknown>> {
  /**
   * The next item. Rejects with an {@link ApiError} when the stream ends with
   * an error (status 200, the end message's `error.code`), with an `Error`
   * "<procedure> ended" when it ends without one, and with an `Error` after
   * `timeoutMs` (default 60,000) without an item.
   */
  next(timeoutMs?: number): Promise<T>;
  /** Reads items until `match` holds for one, and answers it; fails as `next`. */
  until(match: (item: T) => boolean, timeoutMs?: number): Promise<T>;
  /** Every item read so far, in order. */
  items(): readonly T[];
  /** Cancels the stream. Idempotent; never throws. */
  close(): void;
}

/**
 * Opens `procedure` (`<package>.<Service>/<Method>`) with `request` on
 * `baseUrl`'s public listener. Rejects with an {@link ApiError} when the
 * gateway refuses the call before any message (a non-2xx answer).
 */
export const openStream = async <T = Record<string, unknown>>(
  baseUrl: string,
  procedure: string,
  request: unknown = {},
): Promise<ApiStream<T>> => {
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/${procedure}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/connect+json' },
    body: envelope(request),
    signal: abort.signal,
  });

  if (!response.ok || response.body === null) {
    const body = (await response.json().catch(() => undefined)) as unknown;

    abort.abort();
    throw new ApiError(
      response.status,
      (body as { code?: string } | undefined)?.code ?? 'unknown',
      body,
    );
  }

  const reader = response.body.getReader();
  const received: T[] = [];
  const waiters = new Set<() => void>();
  let ended: Error | undefined;
  let read = 0;
  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  const end = (error: Error) => {
    ended ??= error;
    notify();
  };

  // Reads the envelopes as they arrive; the end message settles the stream.
  void (async () => {
    let buffered: Uint8Array = new Uint8Array(0);

    try {
      for (;;) {
        while (buffered.length >= 5) {
          const view = new DataView(
            buffered.buffer,
            buffered.byteOffset,
            buffered.byteLength,
          );
          const flags = view.getUint8(0);
          const length = view.getUint32(1);

          if (buffered.length < 5 + length) break;

          const message = JSON.parse(
            new TextDecoder().decode(buffered.subarray(5, 5 + length)),
          ) as unknown;

          buffered = buffered.slice(5 + length);
          if ((flags & 0b10) !== 0) {
            const error = (message as { error?: { code?: string } }).error;

            end(
              error === undefined
                ? new Error(`${procedure} ended`)
                : new ApiError(200, error.code ?? 'unknown', error),
            );
            await reader.cancel().catch(() => undefined);
            return;
          }
          received.push(message as T);
          notify();
        }

        const { done, value } = await reader.read();

        if (done) {
          end(new Error(`${procedure} ended`));
          return;
        }
        buffered = Buffer.concat([buffered, value]);
      }
    } catch (error) {
      end(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  const next = async (timeoutMs = 60_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (read < received.length) return received[read++] as T;
      if (ended !== undefined) throw ended;

      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        throw new Error(`${procedure}: no item within ${String(timeoutMs)} ms`);
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);

        waiters.add(wake);
      });
    }
  };

  return {
    next,
    until: async (match, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const item = await next(Math.max(0, deadline - Date.now()));

        if (match(item)) return item;
      }
    },
    items: () => [...received],
    close: () => {
      end(new Error(`${procedure} closed`));
      abort.abort();
    },
  };
};

/**
 * The Doric reason of an {@link ApiError}: the `reason` of its body's
 * `google.rpc.ErrorInfo` detail of domain `doric` (`details[].type ===
 * 'google.rpc.ErrorInfo'`, `value` base64), or `undefined` when it has none.
 */
export const reasonOf = (error: ApiError): string | undefined => {
  const details = (error.body as { details?: unknown } | undefined)?.details;

  if (!Array.isArray(details)) return undefined;

  for (const detail of details as { type?: unknown; value?: unknown }[]) {
    if (
      detail.type !== 'google.rpc.ErrorInfo' ||
      typeof detail.value !== 'string'
    ) {
      continue;
    }

    const info = fromBinary(
      ErrorInfoSchema,
      Buffer.from(detail.value, 'base64'),
    );

    if (info.domain === 'doric') return info.reason;
  }

  return undefined;
};
