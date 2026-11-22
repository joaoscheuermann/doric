import { performance } from 'node:perf_hooks';

/** The time of one operation, repeated: its rate and its percentiles. */
export interface Measurement {
  readonly opsPerSecond: number;
  /** Milliseconds. */
  readonly mean: number;
  /** Milliseconds. */
  readonly p50: number;
  /** Milliseconds. */
  readonly p99: number;
}

export interface MeasureOptions {
  /** Runs before timing starts, so the JIT has compiled the operation. */
  readonly warmup: number;
  readonly iterations: number;
}

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
  Number.NaN;

/**
 * Times `operation` one call at a time with `performance.now()`. The value the
 * operation answers is kept, so the engine cannot drop the work.
 */
export const measure = (
  operation: () => unknown,
  { warmup, iterations }: MeasureOptions,
): Measurement => {
  let sink: unknown;
  for (let index = 0; index < warmup; index += 1) sink = operation();

  const times = new Array<number>(iterations);
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    sink = operation();
    times[index] = performance.now() - start;
  }
  if (sink === Symbol.for('never')) throw new Error('unreachable');

  const total = times.reduce((sum, time) => sum + time, 0);
  const sorted = [...times].sort((left, right) => left - right);
  return {
    opsPerSecond: (iterations * 1000) / total,
    mean: total / iterations,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
  };
};
