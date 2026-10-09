/** Execution scope carried by a call; `use(contract, scope)` binds one too. */
export interface CallScope {
  readonly projectId?: string;
  readonly threadId?: string;
  readonly promptId?: string;
  readonly windowKey?: string;
}

/** The principal that made one hop, filled by the dispatcher and never inherited. */
export interface Caller {
  readonly bundleId: string;
  readonly version: string;
  readonly generation: number;
}

/** W3C trace context: `00-<32 hex trace ID>-<16 hex span ID>-01`. */
export interface TraceContext {
  readonly traceparent: string;
}

/** What every `execute` and hook handler receives for one hop. */
export interface Call {
  readonly caller: Caller;
  readonly scope?: CallScope;
  readonly signal: AbortSignal;
  readonly trace: TraceContext;
}

/** The alternative to a parent call as the optional last stub argument. */
export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Epoch milliseconds; 0 or absent means no deadline. */
  readonly deadline?: number;
}

export type CallArg = Call | CallOptions;

/** Brand set on every Call the runtime creates; shared across module instances. */
export const callBrand: unique symbol = Symbol.for('doric.call');

/** Non-enumerable property holding the call deadline (epoch ms, 0 = none). */
export const callDeadline: unique symbol = Symbol.for('doric.call.deadline');

export const isCall = (value: unknown): value is Call =>
  typeof value === 'object' &&
  value !== null &&
  (value as { [callBrand]?: unknown })[callBrand] === true;

const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;

/**
 * Accepts only a plain object whose own keys are a non-empty subset of
 * `signal` and `deadline`, with an `AbortSignal` and a finite number.
 */
export const isCallOptions = (value: unknown): value is CallOptions => {
  if (typeof value !== 'object' || value === null || isCall(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  const keys = Reflect.ownKeys(value);

  if (keys.length === 0) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return keys.every((key) => {
    if (key === 'signal') {
      return isAbortSignal(record.signal);
    }

    if (key === 'deadline') {
      return (
        typeof record.deadline === 'number' && Number.isFinite(record.deadline)
      );
    }

    return false;
  });
};

/** The deadline of a runtime-created call (epoch ms), 0 when it has none. */
export const deadlineOf = (call: Call): number => {
  const value = (call as { [callDeadline]?: unknown })[callDeadline];

  return typeof value === 'number' ? value : 0;
};
