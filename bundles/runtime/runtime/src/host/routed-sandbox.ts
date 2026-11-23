// The domain's sandbox port over `sandbox/v1` by lease id (phase 3, slice
// S47a). The domain keeps seeing `Sandbox`; each of its methods is a
// `sandbox/v1` call with the lease's id.

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { createAsyncIterable } from '@connectrpc/connect/protocol';
import { ContractError } from 'bundle/contracts';
import type { HostContext } from 'bundle/host';
import type {
  Sandbox,
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessInput,
} from 'sandbox';
import { chunkBytes, joinChunks } from 'storage/rpc';

import {
  type PutFileRequestSchema,
  SandboxService,
  type StartRequestSchema,
} from '../contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import type { RuntimePorts } from './ports.js';
import { routed, routedError } from './rpc/errors.js';
import {
  clonedOf,
  cloneInputMessage,
  diffInputMessage,
  execInputMessage,
  execResultOf,
  processInputMessage,
  processOutputOf,
  sshOf,
  statsOf,
} from './rpc/sandbox.js';

/**
 * `RuntimePorts['sandbox']` over `sandbox/v1` (`SandboxService`) through
 * `services`; its contract is unchanged (S46 decision 9: S47 routes it
 * without reshaping it).
 *
 * - `acquire({identity, signal})`: `Acquire({identity})` with `signal` as the
 *   call's signal. Answers a `SandboxLease` whose `sandbox` is a lease sandbox
 *   (below) with `id = sandboxId`, `root = root`, and whose `release()` calls
 *   `Release({leaseId})` (the provider's no-op for an unknown lease; a second
 *   call sends again and is a no-op there too). An aborted `signal` rejects
 *   as the call does.
 * - `discard(identity)`: `Discard({identity})`.
 *
 * A lease sandbox calls the matching `sandbox/v1` method with its `leaseId`,
 * converting with `rpc/sandbox.ts`:
 * - `exec(input)`: `Exec`; `input.signal` is the call's signal; answers
 *   `execResultOf`.
 * - `readFile` / `writeFile` / `diff` / `cloneRepo`: `ReadFile` → `content`;
 *   `WriteFile`; `Diff` → `diff` (no `request` when `input` is undefined);
 *   `CloneRepo` → `clonedOf`.
 * - `putFile(path, bytes)`: `PutFile` with one `head`, then
 *   `chunkBytes(bytes)` (≤ 1 MiB each; none for an empty file).
 *   `getFile(path)`: `GetFile`, the chunks joined (`joinChunks`); empty for
 *   no item.
 * - `stats()`: `Stats` → `statsOf(response)`, or undefined without
 *   `response`. `ssh()`: likewise with `sshOf`.
 * - `start(input)`: opens `Start` with a `head`; resolves once the call is
 *   open (before any output). Each `output` item is passed to
 *   `input.onOutput` in order; `result` resolves with the `exit` item's
 *   `execResultOf`, or rejects as the call fails (a stream that ends without
 *   `exit` rejects with `ContractError('invalid_output')`). `write(data)` /
 *   `resize(cols, rows)` send one request item each, in call order; after the
 *   exit they resolve without sending. `terminate()` cancels the call (the
 *   provider terminates the process tree) and resolves; `result` then
 *   rejects with the cancellation. `UNIMPLEMENTED` (`unsupported_operation`)
 *   rejects `start` itself.
 *
 * Every call inherits the handler call running when it is made (deadline,
 * scope, trace, signal) and none under `detached`. A failure rejects with
 * `fromConnectError`'s `ContractError` (`unknown_lease`,
 * `unsupported_operation`, the provider's own code). Building the port makes
 * no call.
 */
export const routedSandbox = (
  services: HostContext['services'],
): RuntimePorts['sandbox'] => {
  const client = () => services.use(SandboxService);

  /** The sandbox of lease `leaseId`: each method one `sandbox/v1` call. */
  const leaseSandbox = (
    leaseId: string,
    id: string,
    root: string,
  ): Sandbox => ({
    id,
    root,
    exec: ({ signal, ...input }) =>
      routed(async () => {
        const { response } = await client().exec(
          { leaseId, request: execInputMessage(input) },
          signal === undefined ? {} : { signal },
        );
        if (response === undefined)
          throw new ContractError(
            'invalid_output',
            'sandbox/v1.Exec answered no result.',
          );
        return execResultOf(response);
      }),
    readFile: (path) =>
      routed(async () => {
        const { response } = await client().readFile({
          leaseId,
          request: { path },
        });
        return response?.content ?? '';
      }),
    writeFile: (path, content) =>
      routed(async () => {
        await client().writeFile({ leaseId, request: { path, content } });
      }),
    diff: (input) =>
      routed(async () => {
        const { response } = await client().diff({
          leaseId,
          ...(input === undefined ? {} : { request: diffInputMessage(input) }),
        });
        return response?.diff ?? '';
      }),
    cloneRepo: (input) =>
      routed(async () => {
        const { response } = await client().cloneRepo({
          leaseId,
          request: cloneInputMessage(input),
        });
        if (response === undefined)
          throw new ContractError(
            'invalid_output',
            'sandbox/v1.CloneRepo answered no clone.',
          );
        return clonedOf(response);
      }),
    putFile: (path, bytes) =>
      routed(async () => {
        await client().putFile(
          createAsyncIterable<MessageInitShape<typeof PutFileRequestSchema>>([
            { item: { case: 'head', value: { leaseId, request: { path } } } },
            ...chunkBytes(bytes).map((chunk) => ({
              item: { case: 'chunk' as const, value: chunk },
            })),
          ]),
        );
      }),
    getFile: (path) =>
      routed(async () => {
        const chunks: Uint8Array[] = [];
        for await (const { chunk } of client().getFile({
          leaseId,
          request: { path },
        }))
          chunks.push(chunk);
        return joinChunks(chunks);
      }),
    stats: () =>
      routed(async () => {
        const { response } = await client().stats({ leaseId });
        return response === undefined ? undefined : statsOf(response);
      }),
    ssh: () =>
      routed(async () => {
        const { response } = await client().ssh({ leaseId });
        return response === undefined ? undefined : sshOf(response);
      }),
    start: (input) => startProcess(client, leaseId, input),
  });

  return {
    acquire: ({ identity, signal }) =>
      routed(async () => {
        const { leaseId, sandboxId, root } = await client().acquire(
          { identity },
          { signal },
        );
        return {
          sandbox: leaseSandbox(leaseId, sandboxId, root),
          release: () =>
            routed(async () => {
              await client().release({ leaseId });
            }),
        };
      }),
    discard: (identity) =>
      routed(async () => {
        await client().discard({ identity });
      }),
  };
};

type StartRequestInit = MessageInitShape<typeof StartRequestSchema>;

/**
 * `sandbox/v1.Start` on `leaseId`. The call counts as open once the provider
 * reads past the head (it accepted it) or answers its first item; a call that
 * fails before rejects `start` itself.
 */
const startProcess = async (
  client: () => Client<typeof SandboxService>,
  leaseId: string,
  { onOutput, ...input }: SandboxProcessInput,
): Promise<SandboxProcess> => {
  const cancel = new AbortController();
  const pending: StartRequestInit[] = [
    {
      item: {
        case: 'head',
        value: { leaseId, request: processInputMessage(input) },
      },
    },
  ];
  let closed = false;
  let wake: (() => void) | undefined;
  const rouse = () => {
    wake?.();
    wake = undefined;
  };
  let markOpen: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    markOpen = resolve;
  });
  const requests = async function* (): AsyncGenerator<StartRequestInit> {
    let sent = 0;
    for (;;) {
      if (sent > 0) markOpen();
      const next = pending.shift();
      if (next !== undefined) {
        sent += 1;
        yield next;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  const close = () => {
    closed = true;
    rouse();
  };
  const send = (item: StartRequestInit): Promise<void> => {
    if (!closed) {
      pending.push(item);
      rouse();
    }
    return Promise.resolve();
  };

  const result = (async (): Promise<SandboxExecResult> => {
    try {
      for await (const { item } of client().start(requests(), {
        signal: cancel.signal,
      })) {
        markOpen();
        if (item.case === 'output') onOutput?.(processOutputOf(item.value));
        else if (item.case === 'exit') return execResultOf(item.value);
      }
      throw new ContractError(
        'invalid_output',
        'sandbox/v1.Start ended without an exit.',
      );
    } catch (error) {
      throw routedError(error);
    } finally {
      close();
    }
  })();

  await Promise.race([opened, result]);

  return {
    result,
    write: (data) => send({ item: { case: 'write', value: data } }),
    resize: (cols, rows) =>
      send({ item: { case: 'resize', value: { cols, rows } } }),
    terminate: () => {
      close();
      cancel.abort();
      return Promise.resolve();
    },
  };
};
