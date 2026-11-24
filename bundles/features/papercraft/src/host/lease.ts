// `papercraft`'s sandbox runs over the router (phase 3, S57): `runtime.lease/v1`
// as a `PapercraftLease`.

import { Buffer } from 'node:buffer';

import type { MessageInitShape } from '@bufbuild/protobuf';
import { createAsyncIterable } from '@connectrpc/connect/protocol';
import type { HostServices } from 'bundle/host';
import {
  execRequestOf,
  execResultOf,
  type LeaseOutcome,
  runOnProjectLease,
} from 'runtime/contracts';
import {
  LeaseService,
  type PutFileRequestSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';

import type { PapercraftLease } from './ports.js';
import { detached } from './routed.js';
import type { RunnerSandbox } from './sandbox.js';

/** The largest `PutFile` chunk (1 MiB). */
const PUT_CHUNK_BYTES = 1_048_576;

/**
 * `PapercraftLease` over `runtime.lease/v1` with `runOnProjectLease`: `Describe{target: {}}` once, then a `RunnerSandbox`
 * `{id, root, exec, putFile, getFile}` whose every step sends `{expectSandboxId: id}`:
 * - `exec` → `Exec{target, request: execRequestOf(input)}` → `execResultOf` (`exitCode`, `stdout`, `stderr` used);
 * - `putFile(path, bytes)` → `PutFile`: `head{target, request{path}}`, then `bytes` in ≤ 1 MiB chunks (none when empty);
 * - `getFile(path)` → `GetFile{target, request{path}}`, the chunks concatenated.
 * `run(projectId, task)` uses `services.use(LeaseService, {scope: {projectId}})` and runs `detached` (D2). Answers and
 * rejections as `PapercraftLease.run`. Makes no call until `run`.
 */
export const routedPapercraftLease = (
  services: Pick<HostServices, 'use'>,
): PapercraftLease => ({
  run: <T>(
    projectId: string,
    task: (sandbox: RunnerSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>> =>
    detached(() => {
      const lease = services.use(LeaseService, { scope: { projectId } });

      return runOnProjectLease(lease, ({ id, root, target, step }) =>
        task({
          id,
          root,
          exec: async (input) =>
            execResultOf(
              await step(() =>
                lease.exec({ target, request: execRequestOf(input) }),
              ),
            ),
          putFile: async (path, bytes) => {
            const items: MessageInitShape<typeof PutFileRequestSchema>[] = [
              { item: { case: 'head', value: { target, request: { path } } } },
            ];
            for (let at = 0; at < bytes.length; at += PUT_CHUNK_BYTES) {
              items.push({
                item: {
                  case: 'chunk',
                  value: bytes.subarray(at, at + PUT_CHUNK_BYTES),
                },
              });
            }

            await step(() => lease.putFile(createAsyncIterable(items)));
          },
          getFile: (path) =>
            step(async () => {
              const chunks: Uint8Array[] = [];

              for await (const { chunk } of lease.getFile({
                target,
                request: { path },
              })) {
                chunks.push(chunk);
              }

              return new Uint8Array(Buffer.concat(chunks));
            }),
        }),
      );
    }),
});
