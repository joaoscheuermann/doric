/** One aggregate CPU accounting sample read from the guest's `/proc/stat`. */
export interface CpuSample {
  /** Jiffies the guest spent busy across every vCPU. */
  readonly busy: number;
  /** All jiffies recorded across every vCPU. */
  readonly total: number;
}

/** One memory accounting sample read from the guest's `/proc/meminfo`. */
export interface MemorySample {
  readonly totalBytes: number;
  readonly availableBytes: number;
}

export interface GuestStats {
  readonly cpu?: CpuSample;
  readonly memory?: MemorySample;
}

export const parseProcStat = (content: string): CpuSample | undefined => {
  for (const line of content.split('\n')) {
    const fields = line.trim().split(/\s+/u);

    // The aggregate line is `cpu`; per-core lines are `cpu0`, `cpu1`, and so on.
    if (fields[0] !== 'cpu') {
      continue;
    }

    const values = fields.slice(1).map(Number);

    if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
      return undefined;
    }

    const total = values.reduce((sum, value) => sum + value, 0);
    // idle + iowait both count as time the guest was not burning CPU.
    const idle = (values[3] ?? 0) + (values[4] ?? 0);

    return { busy: total - idle, total };
  }

  return undefined;
};

export const parseMeminfo = (content: string): MemorySample | undefined => {
  let totalBytes: number | undefined;
  let availableBytes: number | undefined;

  for (const line of content.split('\n')) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB$/u.exec(line.trim());

    if (match === null) {
      continue;
    }

    const bytes = Number(match[2]) * 1024;

    if (match[1] === 'MemTotal') {
      totalBytes = bytes;
    } else {
      availableBytes = bytes;
    }
  }

  if (totalBytes === undefined || availableBytes === undefined) {
    return undefined;
  }

  return {
    totalBytes,
    availableBytes: Math.min(availableBytes, totalBytes),
  };
};

export const parseGuestStats = (content: string): GuestStats => ({
  cpu: parseProcStat(content),
  memory: parseMeminfo(content),
});

/**
 * The guest's busy share of its own vCPUs, 0..100, from two `/proc/stat`
 * samples. `/proc/stat` sums jiffies across all vCPUs, so the busy fraction of
 * total jiffies is already the fraction of the guest's whole capacity.
 */
export const cpuPercent = (
  previous: CpuSample,
  current: CpuSample,
): number | undefined => {
  const busyDelta = current.busy - previous.busy;
  const totalDelta = current.total - previous.total;

  if (totalDelta <= 0 || busyDelta < 0) {
    return undefined;
  }

  return Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
};

export const memoryUsedBytes = (sample: MemorySample): number =>
  Math.max(0, sample.totalBytes - sample.availableBytes);
