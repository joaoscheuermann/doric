import type { TraceContext } from '../contracts/call.js';

const hex = (bytes: number): string => {
  const values = new Uint8Array(bytes);

  crypto.getRandomValues(values);

  return Array.from(values, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
};

const nonZero = (bytes: number): string => {
  for (;;) {
    const value = hex(bytes);

    if (/[^0]/.test(value)) {
      return value;
    }
  }
};

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A new W3C trace: fresh trace ID and span ID. */
export const newTrace = (): TraceContext =>
  Object.freeze({ traceparent: `00-${nonZero(16)}-${nonZero(8)}-01` });

/** The trace ID of a traceparent, or undefined when it is malformed. */
export const traceIdOf = (trace: TraceContext): string | undefined =>
  traceparentPattern.exec(trace.traceparent)?.[1];

/** A child span: same trace ID and flags, new span ID. */
export const childTrace = (parent: TraceContext): TraceContext => {
  const match = traceparentPattern.exec(parent.traceparent);

  if (match === null) {
    return newTrace();
  }

  return Object.freeze({
    traceparent: `00-${match[1]}-${nonZero(8)}-${match[3]}`,
  });
};
