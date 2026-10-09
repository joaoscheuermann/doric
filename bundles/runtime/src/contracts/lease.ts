import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/*
 * runtime.lease/v1: the sandbox operations the stage-1 tools use on the
 * sandbox leased to the calling prompt's Project (call.scope). Later stages
 * add Git, diff and metrics operations as minor versions. Exec carries no
 * abort signal and returns no byte arrays.
 */

export interface LeaseExecInput {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly env?: readonly string[];
  readonly user?: string;
  readonly timeoutMs?: number;
  readonly tty?: boolean;
}

export interface LeaseExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LeaseDescription {
  readonly id: string;
  readonly root: string;
}

export const leaseExecInputSchema = z
  .object({
    cmd: z.array(z.string()),
    cwd: z.string().optional(),
    env: z.array(z.string()).optional(),
    user: z.string().optional(),
    timeoutMs: z.number().optional(),
    tty: z.boolean().optional(),
  })
  .strict();

export const leaseExecResultSchema = z
  .object({
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

export const leaseDescriptionSchema: z.ZodType<
  LeaseDescription,
  LeaseDescription
> = z.looseObject({
  id: z.string(),
  root: z.string(),
});

export interface RuntimeLease {
  /** The leased sandbox's identity and workspace root. */
  describe(call?: CallArg): Promise<LeaseDescription>;
  exec(input: LeaseExecInput, call?: CallArg): Promise<LeaseExecResult>;
  readFile(path: string, call?: CallArg): Promise<string>;
  writeFile(path: string, content: string, call?: CallArg): Promise<void>;
}

export const runtimeLeaseMethods = {
  describe: { input: z.tuple([]), output: leaseDescriptionSchema },
  exec: { input: leaseExecInputSchema, output: leaseExecResultSchema },
  readFile: { input: z.string(), output: z.string() },
  writeFile: { input: z.tuple([z.string(), z.string()]), output: z.void() },
} as const;

export const RuntimeLeaseV1 = ref<RuntimeLease>('runtime.lease/v1');
