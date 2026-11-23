import { posix as path } from 'node:path';

import {
  bindRegistrant,
  type Call,
  type ContractTool,
  type Registrable,
  type Services,
} from 'bundle/contracts';
import {
  type CwdChange,
  type CwdLocation,
  RuntimeAttachmentsV1,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
} from 'runtime/contracts';
import type { ToolInput, ToolOutput, UnboundTool } from 'tool';

import {
  currentDirectory,
  type LeaseSandbox,
  leaseSandbox,
} from './sandbox.js';

/**
 * What a workspace tool reaches, per call. Every method runs under `call`
 * (its scope, deadline and signal), on the sandbox and Thread of the prompt
 * the call belongs to. Each rejects with the provider's `ContractError`
 * (code, message and details kept). No method retries or caches.
 */
export interface FilesToolPorts {
  /** The working directory of the prompt's Thread, absolute in the sandbox. */
  cwd(call: Call): Promise<string>;
  /**
   * The prompt's sandbox: its `id` and `root`, then `exec`, `readFile` and
   * `writeFile` on that same sandbox. An operation after the sandbox
   * changed rejects with `unavailable` (detail `leaseStatus:
   * 'unavailable'`) and does nothing.
   */
  sandbox(call: Call): Promise<LeaseSandbox>;
  /** Moves the Thread's directory; every outcome is an answer (today's `CwdChange`). */
  setCwd(path: string, call: Call): Promise<CwdChange>;
  /** The Thread's directory and its repository hint, probed now (today's `CwdLocation`). */
  location(call: Call): Promise<CwdLocation>;
  /**
   * Reads the file at `path` (absolute in the sandbox) from the prompt's
   * sandbox and keeps it as an attachment of the call's Thread, named
   * `basename(path)`. Answers the kept attachment's `id` and `name`.
   *
   * Rejects with `runtime.attachments/v1`'s `invalid_input` when the bytes
   * are not a PNG, JPEG, WebP or GIF, are empty, or pass 5 MiB. Rejects with
   * the lease's or the sandbox's failure when the file cannot be read.
   * Nothing is kept on rejection.
   */
  attachFile(
    path: string,
    call: Call,
  ): Promise<{ readonly id: string; readonly name: string }>;
}

/**
 * The ports over the kernel `Services`:
 * - `cwd` is `currentDirectory`; `sandbox` is `leaseSandbox`;
 * - `setCwd`/`location` are `RuntimeWorkspaceV1`'s under `call.scope`;
 * - `attachFile` is `RuntimeLeaseV1.readFileBytes` then
 *   `RuntimeAttachmentsV1.attach({ name, bytes })`.
 *
 * Today's behaviour, unchanged. Kernel-only; deleted in group F.
 */
export const kernelFilesToolPorts = (services: Services): FilesToolPorts => ({
  cwd: (call) => currentDirectory(services, call),
  sandbox: (call) => leaseSandbox(services, call),
  setCwd: (cwd, call) =>
    services.use(RuntimeWorkspaceV1, call.scope).setCwd(cwd, call),
  location: (call) =>
    services.use(RuntimeWorkspaceV1, call.scope).location(call),
  attachFile: async (filePath, call) => {
    const bytes = await services
      .use(RuntimeLeaseV1, call.scope)
      .readFileBytes(filePath, call);
    const attached = await services
      .use(RuntimeAttachmentsV1, call.scope)
      .attach({ name: path.basename(filePath), bytes }, call);

    return { id: attached.id, name: attached.name };
  },
});

/**
 * A kernel `Registrable` of `definition`: its `[bindRegistrant](services)`
 * answers `definition.bind(kernelFilesToolPorts(services))`, since the
 * kernel's `tools/v1` binds every `Registrable` with the registering
 * bundle's `Services`. Kernel-only; deleted in group F.
 */
export const kernelRegistrable = (
  definition: UnboundTool<ToolInput, ToolOutput, FilesToolPorts>,
): Registrable<ContractTool> => ({
  [bindRegistrant]: (services) =>
    definition.bind(kernelFilesToolPorts(services)),
});
