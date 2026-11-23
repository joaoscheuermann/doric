// The router transport of a host part (spec `docs/designs/grpc-processes.md`,
// section 3, "Calls between bundles", and section 10): a Connect gRPC
// transport over cleartext HTTP/2 to `DORIC_ROUTER_URL` whose interceptors
// set the metadata the router reads.

import {
  type DescMessage,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import type { Interceptor, Transport } from '@connectrpc/connect';
import {
  createGrpcTransport,
  type Http2SessionManager,
} from '@connectrpc/connect-node';

import { type Call, deadlineOf } from '../../contracts/call.js';
import { ContractError } from '../../contracts/error.js';
import {
  authorizationHeader,
  callerHeaderPrefix,
  providerHeader,
  scopeHeader,
  scopeHeaderValue,
  targetHeader,
  timeoutHeader,
  timeoutMsOf,
  traceparentHeader,
} from '../../contracts/metadata.js';
import { toConnectError } from '../../contracts/status.js';
import { maxMessageBytes } from '../../platform/router/control.js';
import { anySignal } from '../../runtime/call.js';
import { childTrace, newTrace } from '../../runtime/trace.js';
import { currentCall } from './serve.js';

export interface RouterTransportOptions {
  /** `DORIC_ROUTER_URL`, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The instance token, sent as `authorization: Bearer <token>`. */
  readonly token: string;
  /**
   * The call whose handler makes the calls: each inherits its deadline,
   * scope, trace and signal. Undefined: the call whose handler is running
   * when a call starts (`currentCall()`, `serve.ts`), else none.
   */
  readonly parent?: Call;
  /** Set as `doric-provider` on every call: a provider of a `many` contract. */
  readonly provider?: string;
  /**
   * Set as `doric-target` on every call,
   * `<bundleId>/<generation>/<incarnation>`: the instance a handler service
   * is called on.
   */
  readonly target?: string;
  /**
   * The HTTP/2 sessions to the router, shared with the control stream; a
   * manager of its own when undefined.
   */
  readonly sessionManager?: Http2SessionManager;
}

/**
 * A gRPC transport to the router listener (`createGrpcTransport` of
 * `@connectrpc/connect-node`, HTTP/2, binary). Creating it makes no call.
 * Every call it carries has, whatever the caller's own call options set:
 *
 * - `authorization: Bearer <token>`;
 * - `grpc-timeout` for the earliest of the call's `timeoutMs` and the
 *   parent's deadline (`deadlineOf`), and none when neither has one;
 * - `doric-scope-bin` with the parent's scope (`scopeHeaderValue`), and none
 *   when it has no scope or there is no parent;
 * - `traceparent` with the parent's trace id and a new span id, or a new
 *   trace without a parent;
 * - `doric-provider` and `doric-target` when the options set them;
 * - no header starting with `doric-caller`: the router stamps the caller.
 *
 * The parent's signal aborts the call, as the call's own `signal` does. A
 * call fails as the router or the provider ends it, with a `ConnectError`
 * whose Doric code `fromConnectError` (`contracts/status.ts`) reads.
 */
export const createRouterTransport = (
  options: RouterTransportOptions,
): Transport => {
  const stamp: Interceptor = (next) => (request) => {
    const parent = options.parent ?? currentCall();
    const { header } = request;

    for (const name of [...header.keys()]) {
      if (name.startsWith(callerHeaderPrefix)) {
        header.delete(name);
      }
    }

    header.set(authorizationHeader, `Bearer ${options.token}`);
    header.set(
      traceparentHeader,
      (parent === undefined ? newTrace() : childTrace(parent.trace))
        .traceparent,
    );

    if (options.provider !== undefined) {
      header.set(providerHeader, options.provider);
    }

    if (options.target !== undefined) {
      header.set(targetHeader, options.target);
    }

    if (parent === undefined) {
      return next(request);
    }

    if (parent.scope !== undefined && Object.keys(parent.scope).length > 0) {
      header.set(scopeHeader, scopeHeaderValue(parent.scope));
    }

    const deadline = deadlineOf(parent);
    const ownMs = timeoutMsOf(header.get(timeoutHeader));
    const parentMs = deadline > 0 ? deadline - Date.now() : undefined;
    const timeoutMs =
      ownMs === undefined || (parentMs !== undefined && parentMs < ownMs)
        ? parentMs
        : ownMs;

    if (timeoutMs !== undefined) {
      header.set(timeoutHeader, `${Math.max(1, Math.ceil(timeoutMs))}m`);
    }

    return next({
      ...request,
      signal: anySignal([request.signal, parent.signal]),
    });
  };

  return createGrpcTransport({
    baseUrl: options.url,
    ...(options.sessionManager === undefined
      ? {}
      : { sessionManager: options.sessionManager }),
    interceptors: [stamp, limitRequests],
  });
};

/**
 * Refuses, before it is sent, a request message whose binary form exceeds
 * {@link maxMessageBytes}: the call fails with `RESOURCE_EXHAUSTED`, reason
 * `limit_exceeded`.
 */
const limitRequests: Interceptor = (next) => (request) => {
  const { method } = request;

  if (!request.stream) {
    assertWithinLimit(method.input, request.message);

    return next(request);
  }

  const { message } = request;

  return next({
    ...request,
    message: (async function* () {
      for await (const item of message) {
        assertWithinLimit(method.input, item);
        yield item;
      }
    })(),
  });
};

/** Throws `limit_exceeded` when `message` is over {@link maxMessageBytes}. */
const assertWithinLimit = <Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): void => {
  const bytes = toBinary(schema, message).byteLength;

  if (bytes > maxMessageBytes) {
    throw toConnectError(
      new ContractError(
        'limit_exceeded',
        `A request message of ${bytes} bytes exceeds ${maxMessageBytes} bytes.`,
      ),
    );
  }
};
