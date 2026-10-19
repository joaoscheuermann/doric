import type { Call, Services } from 'bundle/contracts';
import {
  type LeaseExecInput,
  type LeaseExecResult,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
} from 'runtime/contracts';

/**
 * The sandbox as the tools of this bundle reach it: the lease of the calling
 * prompt's Project through `runtime.lease/v1`. It answers only what the tools
 * read (root, text output of a command, file text and bytes) and never forwards an
 * abort signal to the sandbox, as the tools never did.
 */
export interface LeaseSandbox {
  readonly id: string;
  readonly root: string;
  exec(
    input: LeaseExecInput & { readonly signal?: AbortSignal },
  ): Promise<LeaseExecResult>;
  readFile(path: string): Promise<string>;
  /** The file's exact bytes, base64. */
  readFileBytes(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/** The leased sandbox of the prompt that `call` belongs to. */
export const leaseSandbox = async (
  services: Services,
  call: Call,
): Promise<LeaseSandbox> => {
  const lease = services.use(RuntimeLeaseV1, call.scope);
  const { id, root } = await lease.describe(call);

  return {
    id,
    root,
    // Each operation is an async wrapper, so an argument the contract refuses
    // rejects the returned promise instead of throwing past a `.catch`.
    exec: async ({ signal: _signal, ...input }) =>
      await lease.exec(input, call),
    readFile: async (path) => await lease.readFile(path, call),
    readFileBytes: async (path) => await lease.readFileBytes(path, call),
    writeFile: async (path, content) =>
      await lease.writeFile(path, content, call),
  };
};

/** The working directory of the prompt's own Thread. */
export const currentDirectory = async (
  services: Services,
  call: Call,
): Promise<string> =>
  await services.use(RuntimeWorkspaceV1, call.scope).cwd(call);
