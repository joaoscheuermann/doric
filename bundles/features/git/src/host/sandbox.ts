import type { LeaseExecInput, LeaseExecResult } from 'runtime/contracts';
import type { Sandbox } from 'sandbox';

/**
 * The sandbox as `git.commands/v1`'s tasks reach it: identity, root,
 * command execution (text and bytes) and the workspace diff. A live
 * `Sandbox` satisfies it, and so do the routed session and Project
 * sandboxes. It never forwards an abort signal; the call's own applies.
 */
export type GitSandbox = Pick<Sandbox, 'id' | 'root' | 'exec' | 'diff'>;

/**
 * The sandbox as the tools of this bundle reach it: the lease of the calling
 * prompt's Project through `runtime.lease/v1`. It answers only what the tools
 * read (root, text output of a command, file text) and never forwards an
 * abort signal to the sandbox, as the tools never did.
 */
export interface LeaseSandbox {
  readonly id: string;
  readonly root: string;
  exec(
    input: LeaseExecInput & { readonly signal?: AbortSignal },
  ): Promise<LeaseExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
