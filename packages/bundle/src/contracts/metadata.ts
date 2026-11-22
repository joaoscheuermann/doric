// The metadata of a call on the router listener (spec
// `docs/designs/grpc-processes.md`, section 3, "Calls between bundles"): the
// header names the SDKs set and the router reads, and the `Call` a handler
// receives through Connect's `HandlerContext`. Browser-safe: the client SDK
// and the gateway (section 11) read the same names.

import { create } from '@bufbuild/protobuf';
import {
  type ContextKey,
  createContextKey,
  decodeBinaryHeader,
  encodeBinaryHeader,
  type HandlerContext,
} from '@connectrpc/connect';

import { type Call, type CallScope, callScopeSchema } from './call.js';
import { ContractError } from './error.js';
import { CallScopeSchema } from './gen/doric/platform/v1/control_pb.js';

/**
 * The largest message of a call, in either direction, and the largest
 * control-stream frame: 4 MiB (U20), a constant of protocol version 1. The
 * SDKs refuse to send a larger message, with `limit_exceeded`; the router
 * and the gateway refuse to read one.
 */
export const maxMessageBytes = 4 * 1024 * 1024;

/** `Bearer <instance token>`; set by the SDK on every RPC. */
export const authorizationHeader = 'authorization';

/**
 * The call's deadline as gRPC writes it; absent means none. Set by the SDK
 * from `CallOptions.deadline` or from the parent call's deadline.
 */
export const timeoutHeader = 'grpc-timeout';

/** Milliseconds per unit of a {@link timeoutHeader} value. */
const timeoutUnits: Readonly<Record<string, number>> = {
  H: 3_600_000,
  M: 60_000,
  S: 1_000,
  m: 1,
  u: 0.001,
  n: 0.000_001,
};

/**
 * The milliseconds a {@link timeoutHeader} value gives (`<1-8 digits><unit>`,
 * unit one of `HMSmun`); undefined for none or a malformed value. Pure.
 */
export const timeoutMsOf = (value: string | null): number | undefined => {
  const match = /^(\d{1,8})([HMSmun])$/.exec(value ?? '');

  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : Number(match[1]) * (timeoutUnits[match[2]] ?? 0);
};

/** W3C trace context of the caller's span; set by the SDK. */
export const traceparentHeader = 'traceparent';

/**
 * The call scope: a binary `doric.platform.v1.CallScope { entries }`, base64
 * as gRPC writes `-bin` headers; see {@link scopeHeaderValue}.
 */
export const scopeHeader = 'doric-scope-bin';

/**
 * For a contract of cardinality `many`: the bundle id of the provider to
 * call. The router ignores it on a `one` contract.
 */
export const providerHeader = 'doric-provider';

/**
 * For a handler service only: the instance to call,
 * `<bundleId>/<generation>/<incarnation>` (the form of `InstanceKey`). Set by
 * the SDK of the contract's provider.
 */
export const targetHeader = 'doric-target';

/**
 * For a window's call only: the bundle id of the calling client part. Only
 * the gateway passes it on; the router drops it from any request that
 * reaches the router listener (section 3, step 1).
 */
export const clientPartHeader = 'doric-client-part';

/**
 * The prefix of the headers that would name a caller. The router drops every
 * request header that starts with it (step 1): the caller a handler sees is
 * the one the router stamped from the token, never one the request carried.
 */
export const callerHeaderPrefix = 'doric-caller';

/**
 * The value of {@link scopeHeader} for `scope`: the binary
 * `doric.platform.v1.CallScope` whose `entries` are `scope`, in base64. Pure;
 * never throws for a scope `callScopeSchema` accepts. The SDK sends no header
 * for an absent or empty scope.
 */
export const scopeHeaderValue = (scope: CallScope): string =>
  encodeBinaryHeader(
    create(CallScopeSchema, { entries: { ...scope } }),
    CallScopeSchema,
  );

/**
 * The scope a {@link scopeHeader} value carries, frozen. Throws a
 * `ContractError` `invalid_scope` when the value is not base64 of a
 * `CallScope`, or its entries break `callScopeSchema` (more than 16 keys, a
 * key that does not match `scopeKeyPattern`, a value over 512 characters).
 */
export const scopeFromHeader = (value: string): CallScope => {
  let entries: Record<string, string>;

  try {
    entries = decodeBinaryHeader(value, CallScopeSchema).entries;
  } catch (error) {
    throw new ContractError(
      'invalid_scope',
      `The doric-scope-bin header is not a CallScope: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = callScopeSchema.safeParse({ ...entries });

  if (!parsed.success) {
    throw new ContractError(
      'invalid_scope',
      `The doric-scope-bin header breaks the scope bounds: ${parsed.error.message}`,
    );
  }

  return Object.freeze(parsed.data);
};

/**
 * The key under which the host SDK and the router put the `Call` of the
 * request a Connect handler serves, in `HandlerContext.values`. Its default
 * is `undefined`: a handler run by another server has no `Call`.
 */
export const callContextKey: ContextKey<Call | undefined> = createContextKey<
  Call | undefined
>(undefined, { description: 'doric.call' });

/**
 * The key under which the host SDK and `bundle/testing` put the incarnation
 * of the served call's caller (the `CallStart`'s `caller.incarnation`), next
 * to its `Call`, which has none; `stampedCallerOf` reads it. Internal: not
 * exported from the package.
 */
export const callerIncarnationKey: ContextKey<number | undefined> =
  createContextKey<number | undefined>(undefined, {
    description: 'doric.caller-incarnation',
  });

/**
 * The `Call` of the request `context` serves: the caller the router stamped
 * from the token (`{ bundleId, version, generation }`), the scope of
 * `doric-scope-bin` (absent when the request had none), a signal aborted on
 * `CallCancel`, at the deadline, and when the caller cancels or the serving
 * control stream ends, and the trace of the stamped `traceparent`;
 * `deadlineOf` answers the absolute deadline, 0 when none. Every handler the
 * host SDK runs for a `CallStart`, and every handler of a platform service
 * the router serves in process, gets one.
 *
 * Throws a `TypeError` for a context that holds none. The same object on
 * every call for one request.
 */
export const callOf = (context: HandlerContext): Call => {
  const call = context.values.get(callContextKey);

  if (call === undefined) {
    throw new TypeError('The handler context holds no doric Call.');
  }

  return call;
};
