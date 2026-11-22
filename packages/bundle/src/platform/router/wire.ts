// The gRPC framing the relay reads and writes around the payload bytes it
// never decodes (D2): deadlines, traces, headers, statuses and the request
// messages of a call.

import { toBinary } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import type {
  EnvelopedMessage,
  UniversalServerResponse,
} from '@connectrpc/connect/protocol';

import { ContractError, toContractError } from '../../contracts/error.js';
import {
  type Status,
  StatusSchema,
} from '../../contracts/gen/google/rpc/status_pb.js';
import {
  callerHeaderPrefix,
  clientPartHeader,
  timeoutMsOf,
  traceparentHeader,
} from '../../contracts/metadata.js';
import { childTrace, newTrace } from '../../runtime/trace.js';
import { maxMessageBytes } from './control.js';

/** The content type of every gRPC response the router writes. */
export const grpcContentType = 'application/grpc+proto';

/** The absolute deadline a `grpc-timeout` value sets; 0 for none. */
export const deadlineFrom = (value: string | null): number => {
  const ms = timeoutMsOf(value);

  return ms === undefined ? 0 : Date.now() + ms;
};

/** The caller's trace continued with a new span, or a new trace. */
export const traceOf = (header: Headers) => {
  const traceparent = header.get(traceparentHeader);

  return traceparent === null ? newTrace() : childTrace({ traceparent });
};

/** The gRPC path of a request URL. */
export const pathOf = (url: string): string =>
  new URL(url, 'http://router').pathname;

/** Drops the request headers that would name a caller (step 1). */
export const dropCallerHeaders = (header: Headers): void => {
  for (const name of [...header.keys()]) {
    if (name.startsWith(callerHeaderPrefix) || name === clientPartHeader) {
      header.delete(name);
    }
  }
};

/** Writes `status` as gRPC writes the status of a call into `headers`. */
export const writeStatus = (headers: Headers, status: Status): void => {
  headers.set('grpc-status', String(status.code));

  if (status.message !== '') {
    headers.set('grpc-message', encodeURIComponent(status.message));
  }

  if (status.code !== 0) {
    headers.set(
      'grpc-status-details-bin',
      Buffer.from(toBinary(StatusSchema, status)).toString('base64'),
    );
  }
};

/** A response that ends the call with `status` and no message. */
export const trailersOnly = (status: Status): UniversalServerResponse => {
  const header = new Headers({ 'content-type': grpcContentType });

  writeStatus(header, status);

  return { status: 200, header };
};

/** The one request message of a unary or server-streaming call. */
export const onlyMessage = async (
  requests: AsyncIterable<EnvelopedMessage>,
): Promise<Uint8Array> => {
  const messages: Uint8Array[] = [];

  for await (const { flags, data } of requests) {
    if (flags !== 0) {
      throw new ContractError(
        'invalid_input',
        'The router relays no compressed message.',
      );
    }

    messages.push(data);
  }

  const [message] = messages;

  if (message === undefined || messages.length > 1) {
    throw new ContractError(
      'invalid_input',
      `The call carries ${messages.length} request messages, not 1.`,
    );
  }

  return message;
};

/**
 * The `ContractError` a failure to read the caller's request ends the call
 * with: `limit_exceeded` for a request message over {@link maxMessageBytes}.
 */
export const requestError = (error: unknown): ContractError =>
  error instanceof ConnectError && error.code === Code.ResourceExhausted
    ? new ContractError(
        'limit_exceeded',
        `A request message exceeds ${maxMessageBytes} bytes.`,
      )
    : toContractError(error);
