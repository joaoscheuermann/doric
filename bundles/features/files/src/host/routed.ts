// `FilesToolPorts` over the router (phase 3, S53a): `runtime.workspace/v1`'s
// `WorkspaceService`, `runtime.lease/v1`'s `LeaseService` and
// `runtime.attachments/v1`'s `AttachmentsService`.

import { posix as path } from 'node:path';

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { contractErrorOf, type HostServices } from 'bundle/host';
import { cwdChangeSchema, cwdLocationSchema } from 'runtime/contracts';
import {
  AttachmentsService,
  type AttachRequestSchema,
} from 'runtime/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { WorkspaceService } from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';

import { execRequestOf } from './lease.js';
import type { FilesToolPorts } from './ports.js';
import type { LeaseSandbox } from './sandbox.js';

/** Runs `request`, rejecting with `contractErrorOf` of its failure. */
const routed = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

/**
 * The prompt's sandbox over `lease`: `Describe{target: {}}` once, then every
 * step names the described sandbox with `expectSandboxId`, so a step after
 * the sandbox changed fails `unavailable` (`leaseStatus: 'unavailable'`)
 * and does nothing. The `signal` of `exec` is not sent: the call's own
 * signal applies.
 */
const routedLeaseSandbox = async (
  lease: Client<typeof LeaseService>,
): Promise<LeaseSandbox> => {
  const { id, root } = await routed(() => lease.describe({ target: {} }));
  const target = { expectSandboxId: id };

  return {
    id,
    root,
    exec: (input) =>
      routed(async () => {
        const { response } = await lease.exec({
          target,
          request: execRequestOf(input),
        });

        return {
          exitCode: response?.exitCode ?? null,
          stdout: response?.stdout ?? '',
          stderr: response?.stderr ?? '',
        };
      }),
    readFile: (file) =>
      routed(async () => {
        const { response } = await lease.readFile({
          target,
          request: { path: file },
        });

        return response?.content ?? '';
      }),
    writeFile: (file, content) =>
      routed(async () => {
        await lease.writeFile({ target, request: { path: file, content } });
      }),
  };
};

/**
 * `FilesToolPorts` over the router. Every call is made inside the
 * `ToolHandlerService.Execute` handler, so it inherits that call's scope
 * (the prompt: `projectId`, `threadId`, `promptId`), deadline and signal:
 * - `cwd` → `runtime.workspace/v1.Cwd{}` → `cwd`;
 * - `setCwd` → `SetCwd{path}` → `{status, cwd?}`;
 * - `location` → `Location{}` → `{cwd, repo?}`;
 * - `sandbox` → `runtime.lease/v1.Describe{target: {}}` once, then each
 *   `exec`/`readFile`/`writeFile` is `Exec`/`ReadFile`/`WriteFile` with
 *   `target: {expectSandboxId: id}`. `exec` answers `{exitCode (absent →
 *   null), stdout, stderr}`;
 * - `attachFile` → `ReadFileBytes{target: {}, request: {path}}`, piped as it
 *   arrives into `runtime.attachments/v1.Attach`: `head{name:
 *   basename(path)}`, then each chunk. It answers `attachment.{id, name}`.
 *   When `Attach` fails, the read stream is cancelled.
 *
 * A failure rejects as `contractErrorOf` reads it (code, message and
 * details kept). Makes no call until a method is called.
 */
export const routedFilesToolPorts = (
  services: HostServices,
): FilesToolPorts => {
  let workspaceClient: Client<typeof WorkspaceService> | undefined;
  let leaseClient: Client<typeof LeaseService> | undefined;
  let attachmentsClient: Client<typeof AttachmentsService> | undefined;
  const workspace = () => {
    workspaceClient ??= services.use(WorkspaceService);
    return workspaceClient;
  };
  const lease = () => {
    leaseClient ??= services.use(LeaseService);
    return leaseClient;
  };
  const attachments = () => {
    attachmentsClient ??= services.use(AttachmentsService);
    return attachmentsClient;
  };

  return {
    cwd: () => routed(async () => (await workspace().cwd({})).cwd),
    setCwd: (cwd) =>
      routed(async () => {
        const answer = await workspace().setCwd({ path: cwd });

        return cwdChangeSchema.parse(
          answer.cwd === undefined
            ? { status: answer.status }
            : { status: answer.status, cwd: answer.cwd },
        );
      }),
    location: () =>
      routed(async () => {
        const answer = await workspace().location({});

        return cwdLocationSchema.parse(
          answer.repo === undefined
            ? { cwd: answer.cwd }
            : { cwd: answer.cwd, repo: answer.repo },
        );
      }),
    sandbox: () => routedLeaseSandbox(lease()),
    attachFile: async (filePath) => {
      const name = path.basename(filePath);
      const reading = new AbortController();
      // The read's own failure, kept so `Attach` rejects with it rather
      // than with how the request stream reported it.
      let readFailure: { readonly error: unknown } | undefined;
      const chunks = lease().readFileBytes(
        { target: {}, request: { path: filePath } },
        { signal: reading.signal },
      );

      async function* requests(): AsyncGenerator<
        MessageInitShape<typeof AttachRequestSchema>
      > {
        yield { item: { case: 'head', value: { name } } };

        try {
          for await (const { chunk } of chunks) {
            if (chunk.length > 0) {
              yield { item: { case: 'chunk', value: chunk } };
            }
          }
        } catch (error) {
          readFailure ??= { error };
          throw error;
        }
      }

      try {
        const { attachment } = await attachments().attach(requests());

        if (attachment === undefined) {
          throw new Error('Attach answered no attachment.');
        }

        return { id: attachment.id, name: attachment.name };
      } catch (error) {
        throw contractErrorOf(readFailure?.error ?? error);
      } finally {
        // Cancels the read when `Attach` ended before the stream did.
        reading.abort();
      }
    },
  };
};
