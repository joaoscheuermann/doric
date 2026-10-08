/**
 * The machine the Doric host runs on, read by the host itself. A local copy of
 * the host's contract, the way `workspace/usage.ts` copies its own.
 */
export type HostResources = {
  readonly at: string;
  readonly cpuCount: number;
  /** 0..100 between all cores; absent on the first reading. */
  readonly cpuPercent?: number;
  readonly loadAverage?: number;
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly uptimeSeconds: number;
};

/** One sandbox's own resource usage, or why there is no reading. */
export type ContainerResources = {
  readonly status: 'ready' | 'unavailable';
  readonly at: string;
  readonly cpuPercent?: number;
  readonly cpuCount?: number;
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
};
