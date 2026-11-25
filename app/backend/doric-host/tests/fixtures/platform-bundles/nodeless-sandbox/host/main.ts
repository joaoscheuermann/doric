// A test fixture's host part (S62d3b, PC23): `sandbox/v1` 1.1.0 without
// Docker, as a process of its own. Each `Acquire` gets a fresh in-memory
// sandbox whose files live in a map and in which every command answers as a
// shell answers a command it cannot find (exit 127). A Project over it
// becomes ready and its prompts run, while anything that needs a program in
// the sandbox, such as papercraft's `node` runner, fails. Spawned by the
// staged copy's `host/command.json`; `bundle`, `runtime` resolve from the
// workspace's `node_modules`.

import { randomUUID } from 'node:crypto';

import { ContractError } from 'bundle/contracts';
import { runBundle } from 'bundle/host';
import { SandboxService } from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';

/** The provider name `Describe` and every machine answer. */
const provider = 'nodeless-sandbox';

/** The most bytes one `GetFile` item carries: 1 MiB. */
const chunkSize = 1024 * 1024;

/** One held lease: its sandbox's id and files. */
interface Lease {
  readonly sandboxId: string;
  readonly files: Map<string, Uint8Array>;
}

const leases = new Map<string, Lease>();

/** The lease `leaseId` names, or `unknown_lease` when none is held. */
const leaseOf = (leaseId: string): Lease => {
  const lease = leases.get(leaseId);

  if (lease === undefined) {
    throw new ContractError('unknown_lease', `No lease ${leaseId}.`);
  }

  return lease;
};

/** `value`, which the proto requires, or `invalid_input` when absent. */
const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new ContractError('invalid_input', 'The request is missing.');
  }

  return value;
};

/** The bytes stored at `path`, or `internal` when the path was never written. */
const fileOf = (lease: Lease, path: string): Uint8Array => {
  const bytes = lease.files.get(path);

  if (bytes === undefined) {
    throw new ContractError('internal', `No such file: ${path}`);
  }

  return bytes;
};

const unsupported = (operation: string): never => {
  throw new ContractError(
    'unsupported_operation',
    `The nodeless sandbox cannot ${operation}.`,
  );
};

/**
 * `sandbox/v1` (1.1.0) by lease id, over in-memory sandboxes. Serves every
 * method of `SandboxService`; makes no I/O outside its memory.
 *
 * - `Describe` → `{ provider: 'nodeless-sandbox', durableWorkspace: false }`.
 * - `Acquire{identity}` → `{ leaseId, sandboxId: 'nodeless-<identity>',
 *   root: '/workspace' }`: a new unguessable `leaseId` and an empty file map;
 *   the machine `{ id: sandboxId, provider: 'nodeless-sandbox' }` is listed
 *   until the lease is released. `Release{leaseId}` forgets the lease once;
 *   an unknown or released id is a no-op. `Discard` answers at once.
 * - `Machines` → the machines of the held leases; `Machine{id}` → that one,
 *   or no `runningMachine`.
 * - Every operation on a `leaseId` that is unknown or released fails with
 *   `unknown_lease` (`NOT_FOUND`) and touches nothing. Leases are not tied to
 *   the calling instance (the fixture has one caller, `runtime`).
 * - `Exec{request{cmd}}` → `{ exitCode: 127, stdout: '', stderr:
 *   'sh: <cmd[0]>: not found\n', stdoutBytes: empty, stderrBytes: the stderr
 *   bytes }`, whatever the command.
 * - `WriteFile`/`PutFile` store the bytes under the path (`PutFile`: a `head`
 *   then the chunks, stored once at the end; a stream not starting with one
 *   head fails with `invalid_input`). `ReadFile`/`GetFile` answer them
 *   (`GetFile`: chunks of at most 1 MiB, no item for an empty file); a path
 *   never written fails with `internal`, message `No such file: <path>`.
 * - `Diff` → `{ response: { diff: '' } }`; `Stats` and `Ssh` → no `response`.
 * - `CloneRepo` and `Start` fail with `unsupported_operation`
 *   (`UNIMPLEMENTED`); nothing is started or cloned.
 */
runBundle({
  services: [
    [
      SandboxService,
      {
        describe: () => ({ provider, durableWorkspace: false }),
        acquire: ({ identity }) => {
          const leaseId = randomUUID();
          const sandboxId = `nodeless-${identity}`;

          leases.set(leaseId, { sandboxId, files: new Map() });

          return { leaseId, sandboxId, root: '/workspace' };
        },
        release: ({ leaseId }) => {
          leases.delete(leaseId);

          return {};
        },
        discard: () => ({}),
        machines: () => ({
          machines: [...leases.values()].map(({ sandboxId }) => ({
            id: sandboxId,
            provider,
          })),
        }),
        machine: ({ id }) =>
          [...leases.values()].some(({ sandboxId }) => sandboxId === id)
            ? { runningMachine: { id, provider } }
            : {},
        exec: ({ leaseId, request }) => {
          leaseOf(leaseId);
          const stderr = `sh: ${required(request).cmd[0] ?? ''}: not found\n`;

          return {
            response: {
              exitCode: 127,
              stdout: '',
              stderr,
              stdoutBytes: new Uint8Array(0),
              stderrBytes: new TextEncoder().encode(stderr),
            },
          };
        },
        // Refused after its head is read, before any item.
        start: async function* (requests) {
          for await (const { item } of requests) {
            if (item.case === 'head') leaseOf(item.value.leaseId);
            break;
          }

          unsupported('start a process');
        },
        stats: ({ leaseId }) => {
          leaseOf(leaseId);

          return {};
        },
        cloneRepo: ({ leaseId }) => {
          leaseOf(leaseId);

          return unsupported('clone a repository');
        },
        readFile: ({ leaseId, request }) => {
          const lease = leaseOf(leaseId);
          const bytes = fileOf(lease, required(request).path);

          return { response: { content: new TextDecoder().decode(bytes) } };
        },
        writeFile: ({ leaseId, request }) => {
          const lease = leaseOf(leaseId);
          const { path, content } = required(request);

          lease.files.set(path, new TextEncoder().encode(content));

          return {};
        },
        putFile: async (requests) => {
          let target: { readonly lease: Lease; readonly path: string } | undefined;
          const chunks: Uint8Array[] = [];

          for await (const { item } of requests) {
            if (target === undefined) {
              if (item.case !== 'head') {
                throw new ContractError(
                  'invalid_input',
                  'A PutFile stream begins with one head.',
                );
              }

              target = {
                lease: leaseOf(item.value.leaseId),
                path: required(item.value.request).path,
              };
            } else if (item.case === 'chunk') {
              chunks.push(item.value);
            } else {
              throw new ContractError(
                'invalid_input',
                'A PutFile stream carries one head, then chunks.',
              );
            }
          }

          if (target === undefined) {
            throw new ContractError(
              'invalid_input',
              'A PutFile stream begins with one head.',
            );
          }

          target.lease.files.set(target.path, Buffer.concat(chunks));

          return {};
        },
        getFile: async function* ({ leaseId, request }) {
          const bytes = fileOf(leaseOf(leaseId), required(request).path);

          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            yield { chunk: bytes.subarray(offset, offset + chunkSize) };
          }
        },
        diff: ({ leaseId }) => {
          leaseOf(leaseId);

          return { response: { diff: '' } };
        },
        ssh: ({ leaseId }) => {
          leaseOf(leaseId);

          return {};
        },
      },
    ],
  ],
  activate: () => {},
});
