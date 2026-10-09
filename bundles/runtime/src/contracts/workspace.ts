import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/*
 * runtime.workspace/v1: the working directory of the calling prompt's own
 * Thread (call.scope), derived from packages/host's WorkspaceControl.
 */

/** What moving a Thread's working directory did; every outcome is a value. */
export type CwdChange =
  | { readonly status: 'set'; readonly cwd: string }
  /** The resolved path leaves the workspace root. */
  | { readonly status: 'outside' }
  /** No such path. */
  | { readonly status: 'missing' }
  /** The path exists and is not a directory. */
  | { readonly status: 'not-directory' };

export const cwdChangeSchema: z.ZodType<CwdChange, CwdChange> = z.union([
  z.looseObject({ status: z.literal('set'), cwd: z.string() }),
  z.looseObject({ status: z.enum(['outside', 'missing', 'not-directory']) }),
]);

export interface RuntimeWorkspace {
  /** The Thread's current working directory, absolute inside the sandbox. */
  cwd(call?: CallArg): Promise<string>;
  /**
   * Moves the Thread's working directory. A relative path resolves against
   * the current directory, the way `cd` does; outside the workspace root
   * nothing moves.
   */
  setCwd(path: string, call?: CallArg): Promise<CwdChange>;
}

export const runtimeWorkspaceMethods = {
  cwd: { input: z.tuple([]), output: z.string() },
  setCwd: { input: z.string(), output: cwdChangeSchema },
} as const;

export const RuntimeWorkspaceV1 = ref<RuntimeWorkspace>('runtime.workspace/v1');
