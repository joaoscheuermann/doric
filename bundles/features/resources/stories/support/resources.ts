// Resource readings as the host answers them: a MacBook Pro with 32 GiB and
// 12 cores, and a Project's Docker sandbox capped at 4 GiB and 4 cpus. Each
// reading is stamped when it is built, so the tooltip's "Updated Ns ago"
// reads as a live poll.

import type { ResourcesReads } from '../../src/client/api/resources.js';
import type {
  ContainerResources,
  HostResources,
  ProjectResourcesResult,
} from '../../src/client/domain/resources.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** The Project the workspace shows in these stories. */
export const projectId = 'proj_checkout_web';

const stamp = (ageSeconds: number) =>
  new Date(Date.now() - ageSeconds * 1000).toISOString();

export const hostReading = (
  overrides: Partial<HostResources> & { readonly ageSeconds?: number } = {},
): HostResources => {
  const { ageSeconds = 2, ...rest } = overrides;
  return {
    at: stamp(ageSeconds),
    cpuCount: 12,
    cpuPercent: 14.6,
    loadAverage: 2.31,
    memoryTotalBytes: 32 * GiB,
    memoryUsedBytes: 18.4 * GiB,
    uptimeSeconds: 412_380,
    ...rest,
  };
};

export const containerReading = (
  overrides: Partial<ContainerResources> & {
    readonly ageSeconds?: number;
  } = {},
): ContainerResources => {
  const { ageSeconds = 1, ...rest } = overrides;
  return {
    status: 'ready',
    at: stamp(ageSeconds),
    cpuCount: 4,
    cpuPercent: 23.4,
    memoryUsedBytes: 1.2 * GiB,
    memoryLimitBytes: 4 * GiB,
    ...rest,
  };
};

/** A sandbox close to its memory cap: 3.6 of 4 GiB, past the 85% line. */
export const saturatedContainer = () =>
  containerReading({ memoryUsedBytes: 3.6 * GiB, cpuPercent: 61 });

/** A freshly started sandbox: a few hundred MiB, no cpu sample yet. */
export const idleContainer = () =>
  containerReading({ memoryUsedBytes: 312 * MiB, cpuPercent: 0.4 });

export const readyProject = (
  container: ContainerResources = containerReading(),
): ProjectResourcesResult => ({ status: 'ready', container });

/**
 * The monitor's two reads over fixtures. Every poll builds a new reading
 * (a new `at`), the way the host answers; nothing leaves the window.
 */
export const fixtureReads = (input: {
  readonly host?: () => HostResources;
  readonly project?: () => ProjectResourcesResult;
}): ResourcesReads => ({
  host: async () => (input.host ?? hostReading)(),
  project: async () => (input.project ?? (() => readyProject()))(),
});
