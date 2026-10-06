import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';

import type { Sandbox, SandboxStats } from 'sandbox';

/** The machine the host runs on, read from `node:os` on demand. */
export interface HostResources {
  readonly at: string;
  readonly cpuCount: number;
  /** 0..100 between all cores; absent on the first reading. */
  readonly cpuPercent?: number;
  readonly loadAverage?: number;
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly uptimeSeconds: number;
}

/** One sandbox's own resource usage, or why there is no reading. */
export interface ContainerResources {
  readonly status: 'ready' | 'unavailable';
  readonly at: string;
  readonly cpuPercent?: number;
  readonly cpuCount?: number;
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
}

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

/** One provider reading widened into the container contract. */
const containerFrom = (
  stats: SandboxStats,
  at: string,
): ContainerResources => ({
  status: 'ready',
  at,
  ...(stats.cpuPercent === undefined ? {} : { cpuPercent: stats.cpuPercent }),
  ...(stats.cpuCount === undefined ? {} : { cpuCount: stats.cpuCount }),
  ...(stats.memoryUsedBytes === undefined
    ? {}
    : { memoryUsedBytes: stats.memoryUsedBytes }),
  ...(stats.memoryLimitBytes === undefined
    ? {}
    : { memoryLimitBytes: stats.memoryLimitBytes }),
});

/**
 * Reads one sandbox's resources through its provider. A provider that offers no
 * reading, or that fails, leaves the sandbox a working sandbox: the monitor
 * answers `unavailable` rather than letting a read bring a Project down.
 */
export const readSandboxResources = async (
  sandbox: Sandbox,
  now?: Date,
): Promise<ContainerResources> => {
  const at = (now ?? new Date()).toISOString();
  let stats: SandboxStats | undefined;
  try {
    stats = await sandbox.stats?.();
  } catch {
    return { status: 'unavailable', at };
  }
  return stats === undefined
    ? { status: 'unavailable', at }
    : containerFrom(stats, at);
};
