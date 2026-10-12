import { type CallArg, noInput, ref } from 'bundle/contracts';
import {
  type ContainerResources,
  containerResourcesSchema,
  type LeaseOutcome,
} from 'runtime/contracts';
import { z } from 'zod';

/*
 * resources/v1: the machine the host runs on (`GET /resources`) and the
 * Project's sandbox container (`GET /projects/:id/resources`). Stage 9 had
 * the kernel-embedded `transport` provide `host()`; stage 10 (§3.12) moves
 * the provider into the `resources` bundle, which adds `project()`.
 */

export type { ContainerResources, LeaseOutcome } from 'runtime/contracts';

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
  /**
   * `GET /projects/:id/resources`: the container of the Project of
   * `call.scope.projectId`, on the lease it holds now (never acquiring one).
   * A provider without a reading, or a failing one, answers a `ready`
   * outcome whose container is `unavailable`.
   */
  project(call?: CallArg): Promise<LeaseOutcome<ContainerResources>>;
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

export const projectResourcesOutcomeSchema = z.union([
  z.looseObject({
    status: z.literal('ready'),
    value: containerResourcesSchema,
  }),
  z.looseObject({
    status: z.enum(['pending', 'unavailable', 'expired', 'missing']),
  }),
]) as z.ZodType<
  LeaseOutcome<ContainerResources>,
  LeaseOutcome<ContainerResources>
>;

export const resourcesMethods = {
  host: { input: noInput, output: hostResourcesSchema },
  project: { input: noInput, output: projectResourcesOutcomeSchema },
} as const;

export const ResourcesV1 = ref<Resources>('resources/v1');
