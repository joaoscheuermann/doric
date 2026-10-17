import { useQuery } from '@tanstack/react-query';
import { pendingReadInterval } from 'desktop/reads';
import { useState } from 'react';

import type { ResourcesReads } from '../api/resources.js';
import { type CpuSustain, cpuSustained } from '../domain/resources.js';

/** The keys the monitor caches under, as the layout's query keys named them. */
export const resourcesKeys = {
  host: ['resources', 'host'],
  project: (projectId: string) => ['resources', projectId],
} as const;

/** How often a settled resource read is refreshed. */
const resourceInterval = 3000;

/**
 * A lease still forming follows the host's hint; everything else polls at the
 * monitor's own rate. The pending hint comes from the same reducer the sandbox
 * reads use, so a queued Project slows the same way in both places.
 */
const resourceRefetchInterval = (
  result:
    | { readonly status: string; readonly retryAfterSeconds?: number }
    | undefined,
): number => {
  const pending = pendingReadInterval(result);
  return pending === false ? resourceInterval : pending;
};

/**
 * The host machine's resources, kept current while the monitor is mounted. The
 * query holds its last reading through a failed refresh, so the monitor keeps the
 * value it had rather than blinking to an empty state.
 */
export const useHostResources = (reads: ResourcesReads) =>
  useQuery({
    queryKey: resourcesKeys.host,
    queryFn: () => reads.host(),
    refetchInterval: resourceInterval,
    refetchOnWindowFocus: true,
    staleTime: 1000,
    retry: 2,
  });

/**
 * One Project's sandbox resources, or its lease state when there is no live
 * container. Idle until a Project is selected: without an id there is nothing to
 * read, and the monitor shows its dash rather than a read it cannot make.
 */
export const useProjectResources = (
  reads: ResourcesReads,
  projectId: string | undefined,
) =>
  useQuery({
    queryKey: resourcesKeys.project(projectId ?? ''),
    queryFn: () => reads.project(projectId as string),
    enabled: projectId !== undefined,
    refetchInterval: (query) => resourceRefetchInterval(query.state.data),
    refetchOnWindowFocus: true,
    staleTime: 1000,
    retry: 2,
  });

/**
 * The sustained cpu verdict for a polled reading. Only a new reading advances the
 * reducer — a re-render in place does not — so one hot snapshot counts once, and a
 * reading of the same moment cannot climb to a warning on its own. The verdict is
 * derived while rendering the new reading, so a poll commits once rather than
 * once for the reading and again for its verdict.
 */
export const useCpuSustain = (
  at: string | undefined,
  percent: number | undefined,
): boolean => {
  const [sustain, setSustain] = useState<CpuSustain & { readonly at?: string }>(
    { count: 0, sustained: false },
  );
  if (at !== undefined && at !== sustain.at) {
    setSustain({ ...cpuSustained(sustain, percent), at });
  }
  return sustain.sustained;
};
