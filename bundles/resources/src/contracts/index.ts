import { type CallArg, noInput, ref } from 'bundle/contracts';
import { z } from 'zod';

/*
 * resources/v1: the machine the host runs on, as `GET /resources` answers it.
 * In stage 9 the kernel-embedded `transport` provides it beside that route
 * (no host stage owns it yet); stage 10 moves the provider into the
 * `resources` bundle without changing this import path.
 */

/** The machine the host runs on, read from `node:os` on demand. */
export interface HostResources {
  /** ISO-8601 time of the reading. */
  readonly at: string;
  readonly cpuCount: number;
  /** 0..100 between all cores; absent on the first reading of the process. */
  readonly cpuPercent?: number;
  readonly loadAverage?: number;
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly uptimeSeconds: number;
}

export interface Resources {
  /** `GET /resources`: never needs a lease. Remote-callable. */
  host(call?: CallArg): Promise<HostResources>;
}

export const hostResourcesSchema: z.ZodType<HostResources, HostResources> = z
  .object({
    at: z.string(),
    cpuCount: z.number(),
    cpuPercent: z.number().optional(),
    loadAverage: z.number().optional(),
    memoryTotalBytes: z.number(),
    memoryUsedBytes: z.number(),
    uptimeSeconds: z.number(),
  })
  .strict();

export const resourcesMethods = {
  host: { input: noInput, output: hostResourcesSchema },
} as const;

export const ResourcesV1 = ref<Resources>('resources/v1');
