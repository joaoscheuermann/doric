// The routed adapters of `terminal`'s host part as a process (phase 3,
// S54b): `runtime.workspace/v1`, `runtime.lease/v1`, `runtime.threads/v1` and
// `secrets/v1` over the router, in the local shapes the registry and the
// operations take.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import {
  ContractError,
  isContractError,
  type Secrets,
  toStreamObserver,
} from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { contractErrorOf, type HostServices } from 'bundle/host';
import { withThreadSession } from 'runtime/contracts';
import {
  LeaseService,
  type StartRequestSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { ThreadsService } from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { WorkspaceService } from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import type { Sandbox, SandboxExecResult, SandboxProcessInput } from 'sandbox';

import type { RuntimeThreads, RuntimeWorkspace } from './peers.js';

/** The asynchronous context at load: outside every handler's call. */
const outside = AsyncLocalStorage.snapshot();

/**
 * Runs `work` outside every handler's call (the context at load): calls it
 * makes inherit no deadline, signal, scope or trace (D4, D6), as runtime's
 * `detached`.
 */
export const detached = <T>(work: () => T): T => outside(work);

/** Runs `request`, rejecting with `contractErrorOf` of its failure. */
const routed = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

/** A client of `service`, created on first use. */
const lazyClient = <S extends Parameters<HostServices['use']>[0]>(
  services: Pick<HostServices, 'use'>,
  service: S,
): (() => Client<S>) => {
  let client: Client<S> | undefined;

  return () => {
    client ??= services.use(service);

    return client;
  };
};

/**
 * `runtime.workspace/v1` over the router; makes no call until a method is
 * called. Failures reject with `contractErrorOf`'s `ContractError`.
 * - `cwd()`: `WorkspaceService.Cwd{}` under the current call → `cwd`.
 * - `withThread(threadId, options, task)`: `withThreadSession(client,
 *   {threadId, exclusive, resume?, refreshHint?}, …)` under the current call.
 *   The task gets `{projectId, threadId, cwd}` from `ready`, a `sandbox` whose
 *   `start` is `leaseProcessStarter(services, threadSessionId)`, and
 *   `closing()` = `ThreadState{threadSessionId}.closing`, called when it is
 *   called. Answers `withThreadSession`'s outcome. The `call` argument is not
 *   read; the current call is.
 */
export const routedRuntimeWorkspace = (
  services: Pick<HostServices, 'use'>,
): RuntimeWorkspace => {
  const workspace = lazyClient(services, WorkspaceService);

  return {
    cwd: () => routed(async () => (await workspace().cwd({})).cwd),
    withThread: (threadId, options, task) =>
      routed(() =>
        withThreadSession(
          workspace(),
          {
            threadId,
            exclusive: options.exclusive,
            ...(options.resume === undefined ? {} : { resume: options.resume }),
            ...(options.refreshHint === undefined
              ? {}
              : { refreshHint: options.refreshHint }),
          },
          (session) =>
            task({
              projectId: session.projectId,
              threadId: session.threadId,
              cwd: session.cwd,
              sandbox: leaseProcessStarter(services, session.threadSessionId),
              closing: () =>
                routed(
                  async () =>
                    (
                      await workspace().threadState({
                        threadSessionId: session.threadSessionId,
                      })
                    ).closing,
                ),
            }),
        ),
      ),
  };
};

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

/** A failure of `Start` before `started`, as `start` rejects with it (Q4). */
const startFailureOf = (error: unknown): unknown => {
  const failure = contractErrorOf(error);

  return isContractError(failure) && failure.code === 'unsupported_operation'
    ? new ContractError(
        'unsupported_operation',
        'Live terminals are unavailable.',
      )
    : failure;
};

/**
 * `start` over `runtime.lease/v1.Start`, opened `detached` with the head
 * `{target: {threadSessionId}, request: {cmd, cwd?, env, tty?, cols?, rows?}}`
 * (no `timeoutMs`: the registry times out). `start(input)`:
 * - resolves at the `started` item with a `SandboxProcess`, and rejects when
 *   the call fails before it: `unknown_session`, `invalid_input`,
 *   `unsupported_operation` with the message 'Live terminals are
 *   unavailable.' (Q4), or any other code unchanged; `input.signal` already
 *   aborted rejects with its reason and opens nothing;
 * - `input.onOutput({stream, data})` for each `output` item, in order;
 * - `result` resolves with the `exit` item (`exitCode` absent → `undefined`,
 *   `stdout`, `stderr`, bytes), or rejects when the call fails or ends
 *   without `exit` (`invalid_output`);
 * - `write(data)` / `resize(cols, rows)` send one `write` / `resize` item, in
 *   call order; after the exit they resolve without sending;
 * - `terminate()` cancels the call and resolves; `result` then rejects;
 * - `input.signal` aborting after the start cancels the call as `terminate()`.
 */
export const leaseProcessStarter = (
  services: Pick<HostServices, 'use'>,
  threadSessionId: string,
): Pick<Sandbox, 'start'> => ({
  start: async (input: SandboxProcessInput) => {
    input.signal?.throwIfAborted();

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
    input.signal?.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
    requests.push({
      item: {
        case: 'head',
        value: {
          target: { threadSessionId },
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
          const responses = services
            .use(LeaseService)
            .start(requests.drain(), { signal: controller.signal });

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

          throw new ContractError(
            'invalid_output',
            'Start ended with no exit.',
          );
        } catch (error) {
          failStart(startFailureOf(error));
          fail(contractErrorOf(error));
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
  },
});

/**
 * `runtime.threads/v1` over the router, each call `detached` (no scope):
 * `enqueueTerminalResult` → `EnqueueTerminalResult{threadId, promptId,
 * terminalId, text}`, `failTerminalResult` → `FailTerminalResult{threadId}`.
 */
export const routedRuntimeThreads = (
  services: Pick<HostServices, 'use'>,
): RuntimeThreads => {
  const threads = lazyClient(services, ThreadsService);

  return {
    enqueueTerminalResult: ({ threadId, promptId, terminalId, text }) =>
      detached(() =>
        routed(async () => {
          await threads().enqueueTerminalResult({
            threadId,
            promptId,
            terminalId,
            text,
          });
        }),
      ),
    failTerminalResult: ({ threadId }) =>
      detached(() =>
        routed(async () => {
          await threads().failTerminalResult({ threadId });
        }),
      ),
  };
};

/**
 * The redaction list over `secrets/v1` (D7): `redactions()` →
 * `Redactions{}.redactions`; `watchRedactions(listener)` opens
 * `WatchRedactions` `detached` and passes each complete list to the listener
 * until `dispose()`. Never throws synchronously.
 */
export const routedSecrets = (
  services: Pick<HostServices, 'use'>,
): Pick<Secrets, 'redactions' | 'watchRedactions'> => {
  const secrets = lazyClient(services, SecretsService);

  return {
    redactions: () =>
      routed(async () => [...(await secrets().redactions({})).redactions]),
    watchRedactions: (listener) => {
      const observer = toStreamObserver(listener);
      const controller = new AbortController();

      detached(() => {
        void (async () => {
          try {
            for await (const { redactions } of secrets().watchRedactions(
              {},
              { signal: controller.signal },
            )) {
              observer.next([...redactions]);
            }

            if (!controller.signal.aborted) observer.end?.();
          } catch (error) {
            if (controller.signal.aborted) return;

            const failure = contractErrorOf(error);

            observer.end?.(isContractError(failure) ? failure : undefined);
          }
        })();
      });

      return { dispose: () => controller.abort() };
    },
  };
};
