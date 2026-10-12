import type { ContainerResources } from 'runtime/contracts';
import type { Sandbox, SandboxStats } from 'sandbox';

/*
 * The sandbox half of agents/doric's workspace/resources.ts (design 57
 * §11.1), moved verbatim from the runtime's provisional copy (§3.12).
 */

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
