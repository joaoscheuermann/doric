// `files`' host part (phase 3, S53): the seven workspace tools served from
// the bundle's `ToolHandlerService` over the routed ports (S53a), and
// `files/v1` over the calling Project's lease (S53b).

import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import {
  createToolHandlers,
  type HostContext,
  type HostServices,
  type ToolHandlers,
} from 'bundle/host';

import type { FilesService } from '../contracts/gen/doric/files/v1/files_pb.js';
import {
  contentResponseOf,
  createDirectoryResponseOf,
  createFileResponseOf,
  directoriesResponseOf,
  directoryResponseOf,
  readBytesItemsOf,
  treeResponseOf,
} from './codec.js';
import { type ProjectLease, projectLeaseOf } from './lease.js';
import {
  readBytes,
  readContent,
  readDirectories,
  readDirectory,
  readTree,
} from './reads.js';
import { routedFilesToolPorts } from './routed.js';
import { fileTools } from './tools/catalog.js';
import { createEntry } from './writes.js';

export interface FilesHost {
  /**
   * `files/v1` 1.4.0 over the router (S53b). Each method:
   * 1. takes `projectLeaseOf(services, callOf(context))` (D2);
   * 2. runs the kernel task in `lease.run`:
   *    - `Directory` → `readDirectory(sandbox, path)`;
   *    - `Tree` → `readTree`;
   *    - `Directories` → `readDirectories(sandbox, {paths, root?})`;
   *    - `Content` → `readContent(sandbox, path)`;
   *    - `CreateFile` / `CreateDirectory` → `createEntry(sandbox, {directory,
   *      name}, 'file' | 'directory')`;
   *    - `ReadBytes` → `readBytes(sandbox, path)`;
   * 3. answers through `codec.ts`.
   *
   * A non-ready lease is an answer (`{status}`), never an error.
   *
   * Errors:
   * - `invalid_input`: protovalidate (`Directories` with 0 or more than 1000
   *   paths) before the handler, or no `projectId` (`leaseScopeMessage`);
   * - `invalid_scope`: a scope out of bounds;
   * - `unavailable` before `activate` ("files is not activated."), or
   *   runtime unreachable (no `leaseStatus`);
   * - the sandbox's codes, kept;
   * - `limit_exceeded`: an answer over 4 MiB (RK36; Q6).
   */
  readonly files: ServiceImpl<typeof FilesService>;
  /** The tool table `main.ts` serves as `ToolHandlerService`. */
  readonly tools: ToolHandlers;
  /**
   * Binds `routedFilesToolPorts(context.services)`. Then, for each
   * `fileTools` entry in order, it calls `tools.register(context,
   * tool.bind(ports), {alwaysAvailable: true, order})`; each registration
   * is replayed after a `core` restart. Then it binds the `files/v1`
   * services.
   *
   * Resolves once all seven `Register`s resolved. Rejects with the first
   * refusal (`duplicate_tool`, `invalid_input`). The tools registered
   * before a refusal stay registered and served, and `files/v1` stays
   * `unavailable`.
   */
  activate(
    context: Pick<HostContext, 'services' | 'registrations'>,
  ): Promise<void>;
}

/** Builds the host part with no I/O; never throws. */
export const createFilesHost = (): FilesHost => {
  const tools = createToolHandlers();
  let services: HostServices | undefined;

  /** The calling Project's lease (D2); `unavailable` before `activate`. */
  const leaseOf = (context: HandlerContext): ProjectLease => {
    if (services === undefined) {
      throw new ContractError('unavailable', 'files is not activated.');
    }

    return projectLeaseOf(services, callOf(context));
  };

  return {
    files: {
      directory: async (request, context) =>
        directoryResponseOf(
          await leaseOf(context).run((sandbox) =>
            readDirectory(sandbox, request.path),
          ),
        ),
      tree: async (request, context) =>
        treeResponseOf(
          await leaseOf(context).run((sandbox) =>
            readTree(sandbox, request.path),
          ),
        ),
      directories: async (request, context) =>
        directoriesResponseOf(
          await leaseOf(context).run((sandbox) =>
            readDirectories(sandbox, {
              paths: request.paths,
              ...(request.root === undefined ? {} : { root: request.root }),
            }),
          ),
        ),
      content: async (request, context) =>
        contentResponseOf(
          await leaseOf(context).run((sandbox) =>
            readContent(sandbox, request.path),
          ),
        ),
      readBytes: async function* (request, context) {
        yield* readBytesItemsOf(
          await leaseOf(context).run((sandbox) =>
            readBytes(sandbox, request.path),
          ),
        );
      },
      createFile: async (request, context) =>
        createFileResponseOf(
          await leaseOf(context).run((sandbox) =>
            createEntry(
              sandbox,
              { directory: request.directory, name: request.name },
              'file',
            ),
          ),
        ),
      createDirectory: async (request, context) =>
        createDirectoryResponseOf(
          await leaseOf(context).run((sandbox) =>
            createEntry(
              sandbox,
              { directory: request.directory, name: request.name },
              'directory',
            ),
          ),
        ),
    },
    tools,
    activate: async (context) => {
      const ports = routedFilesToolPorts(context.services);

      for (const { tool, order } of fileTools) {
        await tools.register(context, tool.bind(ports), {
          alwaysAvailable: true,
          order,
        });
      }
      services = context.services;
    },
  };
};
