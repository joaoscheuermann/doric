import { type CallArg, ref } from 'bundle/contracts';
import type { SandboxLease } from 'sandpool';
import { z } from 'zod';

import { LOCAL_KEY } from './runtime.js';

/*
 * sandbox/v1: the Project sandboxes the runtime leases (design 57 §2.8 as
 * revised). Only `acquire` is local: it returns the live, process-local
 * lease, marked `object`. `describe`, `discard`, `machines` and `machine` are
 * asynchronous and serializable, so the kernel transport reaches the
 * generation-resident provider. Cardinality `one`; the provisional
 * `sandbox-adapter` provides it until stage 10.
 */

export interface RunningMachine {
  readonly id: string;
  /** 'docker' | 'firecracker' today. */
  readonly provider: string;
}

export interface SandboxDescription {
  readonly provider: string;
  /** Docker keeps a named workspace volume; Firecracker does not. */
  readonly durableWorkspace: boolean;
}

export interface SandboxProviderApi {
  /** What the active provider is (logs and GET /vms). */
  describe(call?: CallArg): Promise<SandboxDescription>;
  /** Named acquisition: the Project's own sandbox. */
  acquire(
    input: { readonly identity: string; readonly signal?: AbortSignal },
    call?: CallArg,
  ): Promise<SandboxLease>;
  /** Discards a deleted Project's durable workspace (Docker volume; Firecracker no-op). */
  discard(identity: string, call?: CallArg): Promise<void>;
  /** Machines provisioned by this provider and not yet disposed. */
  machines(call?: CallArg): Promise<readonly RunningMachine[]>;
  machine(id: string, call?: CallArg): Promise<RunningMachine | undefined>;
}

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

export const sandboxLeaseSchema = z
  .custom<SandboxLease>(
    (value) =>
      isObject(value) &&
      isObject((value as { sandbox?: unknown }).sandbox) &&
      typeof (value as { release?: unknown }).release === 'function',
    { message: 'Expected a sandbox lease.' },
  )
  .meta({ [LOCAL_KEY]: 'object' });

export const abortSignalSchema = z
  .custom<AbortSignal>(
    (value) =>
      isObject(value) &&
      typeof (value as { aborted?: unknown }).aborted === 'boolean',
    { message: 'Expected an abort signal.' },
  )
  .meta({ [LOCAL_KEY]: 'object' });

export const runningMachineSchema: z.ZodType<RunningMachine, RunningMachine> =
  z.looseObject({ id: z.string(), provider: z.string() });

export const sandboxDescriptionSchema: z.ZodType<
  SandboxDescription,
  SandboxDescription
> = z.looseObject({ provider: z.string(), durableWorkspace: z.boolean() });

export const sandboxMethods = {
  describe: { input: z.tuple([]), output: sandboxDescriptionSchema },
  acquire: {
    input: z
      .object({ identity: z.string(), signal: abortSignalSchema.optional() })
      .strict(),
    output: sandboxLeaseSchema,
  },
  discard: { input: z.string(), output: z.void() },
  machines: { input: z.tuple([]), output: z.array(runningMachineSchema) },
  machine: { input: z.string(), output: runningMachineSchema.optional() },
} as const;

export const SandboxV1 = ref<SandboxProviderApi>('sandbox/v1');
