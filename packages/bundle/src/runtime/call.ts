import {
  type Call,
  type CallArg,
  type Caller,
  type CallScope,
  callBrand,
  callDeadline,
  deadlineOf,
  isCall,
} from '../contracts/call.js';
import { childTrace, newTrace } from './trace.js';

export interface CallFactoryInput {
  /** Always the principal making this hop. */
  readonly caller: Caller;
  /** Scope bound by `use(contract, scope)`; its keys win over the parent's. */
  readonly useScope?: CallScope;
  /** Parent call, or `{ signal, deadline }` options. */
  readonly arg?: CallArg;
  /** Aborted when the caller's generation ends; the default signal. */
  readonly generationSignal: AbortSignal;
  /** Client dispatcher only: overwrites `scope.windowKey`. */
  readonly windowKey?: string;
  readonly now?: () => number;
}

const timeoutError = (): Error => {
  const error = new Error('The call deadline elapsed.');

  error.name = 'TimeoutError';

  return error;
};

/** `AbortSignal.any` with a fallback for runtimes that lack it. */
export const anySignal = (signals: readonly AbortSignal[]): AbortSignal => {
  const native = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;

  if (typeof native === 'function') {
    return native.call(AbortSignal, [...signals]);
  }

  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);

      return controller.signal;
    }
  }

  for (const signal of signals) {
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
    });
  }

  return controller.signal;
};

const deadlineSignal = (
  signal: AbortSignal,
  deadline: number,
  now: () => number,
): AbortSignal => {
  const remaining = Math.max(0, deadline - now());
  const controller = new AbortController();

  if (remaining === 0) {
    controller.abort(timeoutError());
  } else {
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => controller.abort(timeoutError()),
      remaining,
    );
    const unref = (timer as { unref?: () => void }).unref;

    if (typeof unref === 'function') {
      unref.call(timer);
    }
  }

  return anySignal([signal, controller.signal]);
};

const mergeScope = (
  parent: CallScope | undefined,
  bound: CallScope | undefined,
  windowKey: string | undefined,
): CallScope | undefined => {
  const merged: Record<string, string> = {};

  for (const source of [parent, bound]) {
    if (source === undefined) {
      continue;
    }

    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        merged[key] = value;
      }
    }
  }

  if (windowKey !== undefined) {
    merged.windowKey = windowKey;
  }

  return Object.keys(merged).length === 0
    ? undefined
    : Object.freeze(merged as CallScope);
};

/** Creates the Call of one dispatcher hop. */
export const createHopCall = (input: CallFactoryInput): Call => {
  const now = input.now ?? Date.now;
  const parent = isCall(input.arg) ? input.arg : undefined;
  const options = parent === undefined ? input.arg : undefined;
  let signal: AbortSignal;
  let deadline: number;

  if (parent !== undefined) {
    signal = parent.signal;
    deadline = deadlineOf(parent);
  } else {
    const given = options as
      | { readonly signal?: AbortSignal; readonly deadline?: number }
      | undefined;

    deadline = given?.deadline ?? 0;
    signal = given?.signal ?? input.generationSignal;

    if (deadline > 0) {
      signal = deadlineSignal(signal, deadline, now);
    }
  }

  const call: Call = {
    caller: Object.freeze({ ...input.caller }),
    signal,
    trace: parent === undefined ? newTrace() : childTrace(parent.trace),
  };
  const scope = mergeScope(parent?.scope, input.useScope, input.windowKey);

  if (scope !== undefined) {
    (call as { scope?: CallScope }).scope = scope;
  }

  Object.defineProperty(call, callBrand, { value: true });
  Object.defineProperty(call, callDeadline, { value: deadline });

  return Object.freeze(call);
};

export { deadlineOf };
