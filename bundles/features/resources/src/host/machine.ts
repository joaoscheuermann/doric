import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';

import type { HostResources } from '../contracts/index.js';

/*
 * The host half of agents/doric's workspace/resources.ts (design 57 §8.1):
 * the machine the host runs on, moved verbatim from the transport (§3.12).
 * The sample is module state of the generation process, as today, so the
 * first reading of the process has no CPU percent.
 */

/** One core's monotonic counters, in the units `cpus()` reports them. */
export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

/**
 * The busy share of every core between two samples, 0..100, or `undefined` when
 * the counters did not advance. It is the whole point of holding a previous
 * sample: the machine's own `cpus()` counters are cumulative since boot.
 */
export const cpuPercentBetween = (
  previous: readonly CpuTimes[],
  current: readonly CpuTimes[],
): number | undefined => {
  const length = Math.min(previous.length, current.length);
  let idle = 0;
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const sample = current[index];
    const before = previous[index];
    if (sample === undefined || before === undefined) continue;
    idle += sample.idle - before.idle;
    total += sample.total - before.total;
  }
  if (total <= 0) return undefined;
  return Math.min(100, Math.max(0, 100 * (1 - idle / total)));
};

/** The counters one `cpus()` reading carries, summed into a single pair. */
const sampleCpuTimes = (): readonly CpuTimes[] =>
  cpus().map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));

/** The previous sample the process keeps so the next reading can diff it. */
let previousCpuTimes: readonly CpuTimes[] | undefined;

/** Reads the host machine, keeping one CPU sample so deltas become a percent. */
export const readHostResources = (now?: Date): HostResources => {
  const current = sampleCpuTimes();
  const cpuPercent =
    previousCpuTimes === undefined
      ? undefined
      : cpuPercentBetween(previousCpuTimes, current);
  previousCpuTimes = current;
  const memoryTotalBytes = totalmem();
  return {
    at: (now ?? new Date()).toISOString(),
    cpuCount: current.length,
    ...(cpuPercent === undefined ? {} : { cpuPercent }),
    loadAverage: loadavg()[0],
    memoryTotalBytes,
    memoryUsedBytes: memoryTotalBytes - freemem(),
    uptimeSeconds: Math.round(uptime()),
  };
};
