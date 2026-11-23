import type { Call, Services } from 'bundle/contracts';
import {
  type LeaseExecInput,
  type LeaseExecResult,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
} from 'runtime/contracts';

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
