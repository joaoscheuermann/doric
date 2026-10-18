import {
  type Call,
  type CallScope,
  callBrand,
  callDeadline,
  callGeneration,
  deadlineOf,
  generationOf,
} from '../../contracts/call.js';
import { anySignal } from '../call.js';
import type { WireCall } from './messages.js';

/** The metadata of a call as it crosses the envelope. */
export const toWireCall = (call: Call): WireCall => {
  const meta: {
    caller: WireCall['caller'];
    scope?: CallScope;
    trace: WireCall['trace'];
    deadline: number;
    generation: number;
  } = {
    caller: {
      bundleId: call.caller.bundleId,
      version: call.caller.version,
      generation: call.caller.generation,
    },
    trace: { traceparent: call.trace.traceparent },
    deadline: deadlineOf(call),
    generation: generationOf(call),
  };

  if (call.scope !== undefined) {
    meta.scope = { ...call.scope };
  }

  return meta;
};

/** The abort reason of an elapsed deadline, as `createHopCall` makes it. */
export const timeoutError = (): Error => {
  const error = new Error('The call deadline elapsed.');

  error.name = 'TimeoutError';

  return error;
};

export interface RestoreOptions {
  /** Aborted by `cancel`, by link close and by the receiving runtime. */
  readonly signals: readonly AbortSignal[];
  /** The kernel overwrites `caller.generation` with its link's generation. */
  readonly callerGeneration?: number;
  readonly now?: () => number;
}

/**
 * Rebuilds the branded Call the sender created: same caller, scope, trace,
 * deadline and generation. Its signal aborts with the given signals and, at
 * the deadline, with a `TimeoutError`, as `createHopCall` does in-process.
 */
export const restoreCall = (meta: WireCall, options: RestoreOptions): Call => {
  const now = options.now ?? Date.now;
  const signals = [...options.signals];
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (meta.deadline > 0) {
    const controller = new AbortController();
    const remaining = Math.max(0, meta.deadline - now());

    if (remaining === 0) {
      controller.abort(timeoutError());
    } else {
      timer = setTimeout(() => controller.abort(timeoutError()), remaining);

      const unref = (timer as { unref?: () => void }).unref;

      if (typeof unref === 'function') {
        unref.call(timer);
      }
    }

    signals.push(controller.signal);
  }

  const signal =
    signals.length === 1 ? (signals[0] as AbortSignal) : anySignal(signals);
  const call: Call = {
    caller: Object.freeze({
      bundleId: meta.caller.bundleId,
      version: meta.caller.version,
      generation: options.callerGeneration ?? meta.caller.generation,
    }),
    signal,
    trace: Object.freeze({ traceparent: meta.trace.traceparent }),
  };

  if (meta.scope !== undefined) {
    const scope: Record<string, string> = {};

    for (const [key, value] of Object.entries(meta.scope)) {
      if (typeof value === 'string') {
        scope[key] = value;
      }
    }

    if (Object.keys(scope).length > 0) {
      (call as { scope?: CallScope }).scope = Object.freeze(scope as CallScope);
    }
  }

  Object.defineProperty(call, callBrand, { value: true });
  Object.defineProperty(call, callDeadline, { value: meta.deadline });
  Object.defineProperty(call, callGeneration, { value: meta.generation });

  return Object.freeze(call);
};
