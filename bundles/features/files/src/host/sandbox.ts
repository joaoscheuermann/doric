import type { LeaseExecInput, LeaseExecResult } from 'runtime/contracts';

/**
 * The sandbox as the tools reach it: identity, root, plain command
 * execution (text output), file text in and out. It never forwards an
 * abort signal to the sandbox; the call's own signal applies.
 * (1.x had `readFileBytes`; its one user, view-image, now reads through
 * `FilesToolPorts.attachFile`.)
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
