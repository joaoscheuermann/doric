// The window side of the desktop bridge: remote provider records over
// `window.doric.desktop` and the bootstrap's own `doric.shell/v1` calls.

import {
  type Call,
  ContractError,
  type Disposable,
  deadlineOf,
  type StreamListener,
  toStreamObserver,
} from 'bundle/contracts';
import { newTrace, type ProviderRecord } from 'bundle/runtime';
import { z } from 'zod';

import {
  type BridgeCallEnvelope,
  type BridgeError,
  type BridgeResultPayload,
  type BridgeScope,
  type DoricDesktopApi,
  type RemoteContract,
  type RemoteMethodSpec,
  SHELL_CONTRACT,
  type ShellMethod,
} from './protocol.js';

let sequence = 0;
const prefix = Math.random().toString(36).slice(2, 10);

/** A call ID unique in this window. */
export const nextCallId = (): string => {
  sequence += 1;

  return `${prefix}-${sequence}`;
};

/** The ContractError a bridge answer carries. */
export const bridgeError = (error: BridgeError): ContractError =>
  new ContractError(error.code, error.message, error.details);

const settle = (result: BridgeResultPayload): unknown => {
  if (result.ok) {
    return result.output;
  }

  throw bridgeError(result.error);
};

/** The call scope without `windowKey`: main fills it for the window. */
export const withoutWindowKey = (call: Call): BridgeScope | undefined => {
  if (call.scope === undefined) {
    return undefined;
  }

  const { windowKey: _windowKey, ...rest } = call.scope;

  return Object.keys(rest).length === 0 ? undefined : rest;
};

const isListener = (value: unknown): value is StreamListener<unknown> =>
  typeof value === 'function' ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function');

/**
 * Opens a stream over the bridge: items reach the listener until main sends
 * `end` or the returned Disposable unsubscribes.
 */
const openStream = (
  desktop: DoricDesktopApi,
  envelope: BridgeCallEnvelope,
  listener: StreamListener<unknown>,
): Disposable => {
  const observer = toStreamObserver(listener);
  let open = true;
  const unsubscribe = desktop.subscribe(envelope, (event) => {
    if (!open) {
      return;
    }

    if (event.type === 'event') {
      observer.next(event.event);

      return;
    }

    open = false;
    observer.end?.(
      event.error === undefined ? undefined : bridgeError(event.error),
    );
  });

  return {
    dispose: () => {
      open = false;
      unsubscribe();
    },
  };
};

const methodSpec = (spec: RemoteMethodSpec) =>
  Object.freeze({
    input:
      spec.tuple === null
        ? z.unknown()
        : z.tuple(
            Array.from({ length: spec.tuple }, () =>
              z.unknown().optional(),
            ) as unknown as [z.ZodType, ...z.ZodType[]],
          ),
    output: z.unknown(),
  });

/**
 * A remote contract as a provider record of the window's directory. The
 * record only splits the trailing call argument by tuple length [S8-12];
 * main validates the input against the descriptor's JSON Schema and the
 * provider validates it again. `caller.bundleId` is the principal the stub
 * is bound to, so main sees the right bundle.
 */
export const remoteContractRecord = (
  desktop: DoricDesktopApi,
  contract: RemoteContract,
): ProviderRecord => {
  const methods = Object.fromEntries(
    Object.entries(contract.methods).map(([name, spec]) => [
      name,
      methodSpec(spec),
    ]),
  );
  const envelopeOf = (
    method: string,
    input: unknown,
    call: Call,
  ): BridgeCallEnvelope => {
    const scope = withoutWindowKey(call);

    return {
      id: nextCallId(),
      contract: contract.id,
      method,
      input,
      bundleId: call.caller.bundleId,
      ...(scope === undefined ? {} : { scope }),
      deadline: deadlineOf(call),
      traceparent: call.trace.traceparent,
    };
  };

  return Object.freeze({
    contractId: contract.id,
    bundleId: contract.bundleId,
    version: contract.version,
    contractVersion: contract.contractVersion,
    environment: contract.environment,
    cardinality: contract.cardinality,
    methods,
    origin: 'remote' as const,
    invoke: (method: string, input: unknown, call: Call): unknown => {
      const spec = contract.methods[method] as RemoteMethodSpec;

      if (spec.local) {
        throw new ContractError(
          'local_only',
          `${contract.id} ${method} cannot be called across the desktop bridge.`,
          { contract: contract.id, method },
        );
      }

      if (spec.stream) {
        const items = Array.isArray(input) ? input : [input];
        const listener = items.at(-1);

        if (!isListener(listener)) {
          throw new ContractError(
            'invalid_input',
            `Invalid input for ${contract.id} ${method}: Expected a stream listener.`,
            { contract: contract.id, method },
          );
        }

        return openStream(
          desktop,
          envelopeOf(method, items.slice(0, -1), call),
          listener,
        );
      }

      const envelope = envelopeOf(method, input, call);
      const onAbort = () => desktop.cancel(envelope.id);

      // Advisory, as across the process envelope: the provider decides how
      // an aborted call ends.
      if (call.signal.aborted) {
        onAbort();
      } else {
        call.signal.addEventListener('abort', onAbort, { once: true });
      }

      return desktop
        .call(envelope)
        .finally(() => call.signal.removeEventListener('abort', onAbort))
        .then(settle);
    },
  });
};

const shellEnvelope = (
  method: ShellMethod,
  input: unknown,
): BridgeCallEnvelope => ({
  id: nextCallId(),
  contract: SHELL_CONTRACT,
  method,
  input,
  bundleId: null,
  deadline: 0,
  traceparent: newTrace().traceparent,
});

/** One `doric.shell/v1` call of the window platform (`bundleId: null`). */
export const shellCall = async (
  desktop: DoricDesktopApi,
  method: ShellMethod,
  input: unknown,
): Promise<unknown> => settle(await desktop.call(shellEnvelope(method, input)));

/** A fire-and-forget `doric.shell/v1` call: failures are dropped. */
export const shellNotify = (
  desktop: DoricDesktopApi,
  method: ShellMethod,
  input: unknown,
): void => {
  try {
    desktop.call(shellEnvelope(method, input)).catch(() => undefined);
  } catch {
    // The bridge is gone; nothing to tell.
  }
};

/** Subscribes to a `doric.shell/v1` stream. */
export const shellStream = <T>(
  desktop: DoricDesktopApi,
  method: ShellMethod,
  listener: StreamListener<T>,
): Disposable =>
  openStream(
    desktop,
    shellEnvelope(method, []),
    listener as StreamListener<unknown>,
  );
