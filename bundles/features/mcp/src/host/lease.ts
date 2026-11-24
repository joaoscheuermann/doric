// `mcp`'s stdio servers over the router (phase 3, S59 D4): `runtime.lease/v1`
// as an `McpLease`.

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { contractErrorOf, type HostServices } from 'bundle/host';
import { type LeaseOutcome, runOnProjectLease } from 'runtime/contracts';
import {
  LeaseService,
  type StartRequestSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import type {
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessInput,
} from 'sandbox';

import type { McpLease, McpSandbox } from './ports.js';
import { detached } from './routed.js';

type StartItem = MessageInitShape<typeof StartRequestSchema>;

/** The `Start` request stream: the items pushed, in order, until `close`. */
const requestQueue = () => {
  const items: StartItem[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  return {
    push: (item: StartItem) => {
      if (closed) return;
      items.push(item);
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
    async *drain(): AsyncGenerator<StartItem> {
      for (;;) {
        const item = items.shift();

        if (item !== undefined) {
          yield item;
          continue;
        }

        if (closed) return;

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
};

/** Opens `Start` on `lease`, `detached`, and resolves at `started` with the live process. */
const openStart = async (
  lease: Client<typeof LeaseService>,
  target: { readonly expectSandboxId: string },
  input: SandboxProcessInput,
): Promise<SandboxProcess> => {
  const controller = new AbortController();
  const requests = requestQueue();
  let exited = false;
  let markStarted: () => void = () => undefined;
  let failStart: (error: unknown) => void = () => undefined;
  const started = new Promise<void>((resolve, reject) => {
    markStarted = resolve;
    failStart = reject;
  });
  let settle: (result: SandboxExecResult) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const result = new Promise<SandboxExecResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  // A start that failed leaves `result` unread.
  void result.catch(() => undefined);
  requests.push({
    item: {
      case: 'head',
      value: {
        target: { ...target },
        request: {
          cmd: [...input.cmd],
          env: [...(input.env ?? [])],
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.tty === undefined ? {} : { tty: input.tty }),
          ...(input.cols === undefined ? {} : { cols: input.cols }),
          ...(input.rows === undefined ? {} : { rows: input.rows }),
        },
      },
    },
  });

  detached(() => {
    void (async () => {
      try {
        const responses = lease.start(requests.drain(), {
          signal: controller.signal,
        });

        for await (const { item } of responses) {
          if (item.case === 'started') markStarted();
          else if (item.case === 'output') {
            input.onOutput?.({
              stream: item.value.stream === 'stderr' ? 'stderr' : 'stdout',
              data: item.value.data,
            });
          } else if (item.case === 'exit') {
            exited = true;
            settle({
              exitCode: item.value.exitCode ?? null,
              stdout: item.value.stdout,
              stderr: item.value.stderr,
              stdoutBytes: item.value.stdoutBytes,
              stderrBytes: item.value.stderrBytes,
            });
            markStarted();

            return;
          }
        }

        throw new ContractError('invalid_output', 'Start ended with no exit.');
      } catch (error) {
        const failure = contractErrorOf(error);
        failStart(failure);
        fail(failure);
      } finally {
        requests.close();
      }
    })();
  });

  await started;

  return {
    result,
    write: (data: string) => {
      if (!exited) requests.push({ item: { case: 'write', value: data } });

      return Promise.resolve();
    },
    resize: (cols: number, rows: number) => {
      if (!exited) {
        requests.push({ item: { case: 'resize', value: { cols, rows } } });
      }

      return Promise.resolve();
    },
    terminate: () => {
      controller.abort();

      return Promise.resolve();
    },
  };
};

/**
 * `McpLease` over `runtime.lease/v1` (D4). `run(projectId, task)`, `detached`, with `lease = services.use(LeaseService,
 * {scope: {projectId}})` (no thread, no prompt: the Project's current lease): `runOnProjectLease(lease, steps =>
 * task({start}))` where `start(input)` is `steps.step(() => <open Start>)`:
 * - opens `Start` `detached` with the head `{target: steps.target, request: {cmd, env, cwd?, tty?, cols?, rows?}}`;
 * - resolves at `started` with a `SandboxProcess`: `onOutput` per `output` item in order; `result` resolves with the
 *   `exit` item (`exitCode` absent → `null`) or rejects when the stream fails or ends without `exit`
 *   (`invalid_output`); `write`/`resize` send one item each, nothing after the exit; `terminate()` cancels the stream;
 * - rejects before `started` with the failure as `contractErrorOf` reads it (`unsupported_operation`, `unavailable`
 *   with `leaseStatus` — then the run's outcome is that status — or any other code).
 * Answers and rejections as `McpLease.run`. Makes no call until `run`.
 */
export const routedMcpLease = (
  services: Pick<HostServices, 'use'>,
): McpLease => ({
  run: <T>(
    projectId: string,
    task: (sandbox: McpSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>> =>
    detached(() => {
      const lease = services.use(LeaseService, { scope: { projectId } });

      return runOnProjectLease(lease, ({ target, step }) =>
        task({ start: (input) => step(() => openStart(lease, target, input)) }),
      );
    }),
});
