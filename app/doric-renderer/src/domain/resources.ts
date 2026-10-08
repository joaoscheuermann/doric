import type { ProjectLeaseState } from './workspace';

/**
 * The resource monitor's vocabulary: what a host and a Project's container read,
 * and the rules that turn those numbers into the one line each control shows.
 * Everything here is stated in terms of its arguments — the bytes, the ratio, the
 * reading's timestamp — so the thresholds and wording can be checked without a
 * clock, a DOM or a running host.
 */

/** The host machine, as the Doric process read it from `node:os`. */
export type HostResources = {
  readonly at: string;
  readonly cpuCount: number;
  /** 0..100 across every core; absent on the first read. */
  readonly cpuPercent?: number;
  readonly loadAverage?: number;
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly uptimeSeconds: number;
};

/** The Project's sandbox container, as its provider measured it. */
export type ContainerResources = {
  readonly status: 'ready' | 'unavailable';
  readonly at: string;
  readonly cpuPercent?: number;
  readonly cpuCount?: number;
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
};

/**
 * One Project's resources: the container's numbers when a lease is alive, or the
 * lease state the other sandbox reads answer with. A `ready` answer whose
 * container is `unavailable` means the provider is up but cannot measure.
 */
export type ProjectResourcesResult =
  | { readonly status: 'ready'; readonly container: ContainerResources }
  | {
      readonly status: ProjectLeaseState;
      readonly retryAfterSeconds?: number;
    };

const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** A magnitude, rounded to a tenth and with a trailing `.0` dropped. */
const formatNumber = (value: number): string =>
  value.toFixed(1).replace(/\.0$/, '');

/** The unit index a magnitude belongs to: the largest one that does not overflow. */
const unitIndex = (bytes: number): number => {
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index;
};

/** Those bytes in one unit, e.g. `3` for `3 * GiB`. */
const inUnit = (bytes: number, index: number): number => bytes / 1024 ** index;

/** A byte count in the largest unit that fits, e.g. `"512 MiB"`, `"1.5 GiB"`. */
export const bytesLabel = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const index = unitIndex(bytes);
  return `${formatNumber(inUnit(bytes, index))} ${units[index]}`;
};

/**
 * A used/limit pair as one label, e.g. `"0.3 / 2 GiB"` when both are known. Both
 * halves share the pair's unit — the one the larger value falls in — so the limit
 * sets the scale and the used value reads as a fraction of it. A missing half is
 * said rather than guessed: no limit leaves the used value alone, and no used
 * value leaves a dash.
 */
export const memoryLabel = (used?: number, limit?: number): string => {
  if (used === undefined || !Number.isFinite(used)) return '—';
  if (limit === undefined || !Number.isFinite(limit)) return bytesLabel(used);
  const index = unitIndex(Math.max(used, limit));
  return `${formatNumber(inUnit(used, index))} / ${formatNumber(
    inUnit(limit, index),
  )} ${units[index]}`;
};

/** A cpu fraction as a percentage, or a dash when the host did not measure one. */
export const cpuLabel = (percent?: number): string =>
  percent !== undefined && Number.isFinite(percent)
    ? `${Math.round(percent)}%`
    : '—';

/**
 * The sentence a Project's resource state reads as, when it is not simply ready.
 * `undefined` means there is nothing to explain: a readable container.
 */
export const resourceNotice = (
  result: ProjectResourcesResult | undefined,
): string | undefined => {
  if (result === undefined) return undefined;
  if (result.status === 'ready') {
    return result.container.status === 'unavailable'
      ? 'Resources unavailable in this provider'
      : undefined;
  }
  return result.status === 'pending'
    ? 'Preparing environment…'
    : 'Environment unavailable';
};

/** Memory this far into its limit warns; the bar reads as saturated. */
export const memorySaturationRatio = 0.85;

/** Cpu at this percentage counts toward sustained saturation. */
export const cpuSaturationPercent = 90;

/** How many consecutive hot readings make a cpu sustained rather than a spike. */
export const cpuSustainedReadings = 3;

/** The run of consecutive hot cpu readings, and whether it is long enough. */
export type CpuSustain = {
  readonly count: number;
  readonly sustained: boolean;
};

/**
 * The reducer behind sustained cpu: each hot reading extends the run, and the
 * run is only a warning once it reaches `cpuSustainedReadings`. A cold or absent
 * reading breaks it.
 */
export const cpuSustained = (
  previous: CpuSustain,
  current: number | undefined,
): CpuSustain => {
  if (current !== undefined && Number.isFinite(current)) {
    if (current >= cpuSaturationPercent) {
      const count = previous.count + 1;
      return { count, sustained: count >= cpuSustainedReadings };
    }
  }
  return { count: 0, sustained: false };
};

export type SaturationInput = {
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
  readonly cpuSustained?: boolean;
};

/** Whether memory is deep into its limit, or cpu has stayed hot, or neither. */
export const isSaturated = (input: SaturationInput): boolean => {
  const memory =
    input.memoryUsedBytes !== undefined &&
    input.memoryLimitBytes !== undefined &&
    Number.isFinite(input.memoryUsedBytes) &&
    Number.isFinite(input.memoryLimitBytes) &&
    input.memoryLimitBytes > 0 &&
    input.memoryUsedBytes / input.memoryLimitBytes >= memorySaturationRatio;
  return memory || input.cpuSustained === true;
};

export type ResourceSeverity = 'warning' | 'normal';

/** The tone a reading's value wears: `warning` only when it crossed a threshold. */
export const severity = (input: SaturationInput): ResourceSeverity =>
  isSaturated(input) ? 'warning' : 'normal';

/**
 * How long ago a reading was taken, as the tooltip says it: `"Updated 2s ago"`.
 * The reading's timestamp is the argument, so the wording is checked with a
 * fixed clock rather than the one on the wall.
 */
export const freshnessLabel = (at: string, now: Date = new Date()): string => {
  const taken = new Date(at).getTime();
  if (Number.isNaN(taken)) return '';
  const seconds = Math.max(0, Math.floor((now.getTime() - taken) / 1000));
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
};
