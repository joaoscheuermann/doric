// The executor port over `executor/v1` (phase 3, slice S48b): each call opens
// an executor session the provider calls back through `executor.session/v1`.

import { type CallArg, ContractError, isContractError } from 'bundle/contracts';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import type { HostContext } from 'bundle/host';

import {
  type ExecutorCompactionResult,
  type ExecutorThread,
  executorMethods,
} from '../contracts/executor.js';
import {
  CompactResponseSchema,
  ExecutorService,
  ExecutorThreadSchema,
  PromptJobSchema,
} from '../contracts/gen/doric/executor/v1/executor_pb.js';
import type {
  ExecutorSessions,
  OpenedExecutorSession,
  SessionCallbacks,
} from './executor-sessions.js';
import type { RuntimePorts } from './ports.js';
import { decode, encode, runtimeOneofs } from './rpc/codec.js';
import { routed } from './rpc/errors.js';
import { historyPatchOf } from './rpc/history.js';

/** The contract the executor port calls. */
const EXECUTOR_CONTRACT = 'executor/v1';

/**
 * How long `run` waits, after the prompt's signal aborted, for the executor to end `Run` by itself before it
 * cancels the `Run` call: 5 s. A constant of `runtime` (as the supervision timings are, D14), below the 10 s stop
 * timeout so a cancelled run still ends before a stopping `runtime` is killed.
 */
export const executorCancelGraceMs = 5_000;

export interface RoutedExecutorOptions {
  /** Replaces {@link executorCancelGraceMs}; tests only. */
  readonly cancelGraceMs?: number;
}

/**
 * `RuntimePorts['executor']` over `executor/v1` (`ExecutorService`) through
 * `context.services`. `executor(scope)` answers an `Executor` whose every
 * call is made with `use(ExecutorService, {scope})` (S48a), so the executor
 * sees the prompt's `{projectId, threadId, promptId}`, and with the `call`
 * argument's `signal` as the call's signal (no deadline of its own). Makes no
 * call until a method is used — nothing at `activate`.
 *
 * - **Provider.** The bundle that provides `executor/v1`:
 *   `doric.catalog/v1.Get`'s host contract `executor/v1`, its first provider,
 *   read at the first session and kept; a failed read is not kept (the next
 *   session reads again). No provider fails the method `unavailable` ('No
 *   bundle provides executor/v1.') before any `executor/v1` call. Forgotten
 *   on each `Formats` replay (a new provider instance), then read again.
 * - **Sessions.** `run`, `compact`, `checkpoint` and `rewind` each
 *   `sessions.open(provider, callbacks)` (run and compact: `input.session`;
 *   checkpoint and rewind: `{history: input.history}`), pass its id as
 *   `sessionId`, and end it when the call settles (resolved, rejected or
 *   cancelled), so a later callback is `unknown_session`.
 * - `run({thread, job, session})` → `Run{sessionId, thread, job}` (thread
 *   and job `encode`d with `runtimeOneofs`; the thread's `agent` keeps its
 *   `instructions`); answers `{text}`.
 * - `compact({thread, session, policy})` → `Compact{sessionId, thread,
 *   policy}`; the response `decode`d and parsed with
 *   `executorMethods.compact.output`; a mismatch rejects `invalid_output`.
 * - `checkpoint({history, promptId})` → `Checkpoint{sessionId, promptId}`,
 *   answered by `historyPatchOf`; a stream with no item rejects
 *   `invalid_output`.
 * - `rewind({history, promptId, removedPromptIds})` → `Rewind{…}`,
 *   `historyPatchOf` (no item: `undefined`).
 * - `formats()` → the cached list. The first use calls
 *   `context.registrations.track(ExecutorService, (c) => c.formats({}),
 *   {onReplayed})`; its answer is kept, and each replay to a new provider
 *   instance (`ProviderChanged`) replaces it (`onReplayed`). One `Formats`
 *   call per executor instance; concurrent first uses share it. A rejected
 *   first call is not kept and rejects `formats()` (the next use calls
 *   again).
 * - Every routed failure rejects as `routedError` reads it (executor codes
 *   pass through unchanged).
 *
 * (Addition to S48's contract.) A `run` or `compact` failing `provider_error` whose `details.providerError` is an
 * object with string `provider`, `code` and `message` rejects with an `Error` whose `name` is `'ProviderError'`,
 * `message` the data's message and own `data` the details' object — the shape of llms' `ProviderErrorObject`, so the
 * prompt's `agent.failed` event reads (`errorInfo`) as it did in process. Every other failure as before.
 *
 * (S51e: changes the `run` bullet; every other method as before.)
 * - `run({thread, job, session}, call)` → `Run{sessionId, thread, job}` made with a signal of its own, not
 *   `call.signal`. When `call.signal` aborts (or is aborted already) while `Run` is in flight:
 *   1. the session is cancelled (`OpenedExecutorSession.cancel()`), so the executor's `WatchCancel` answers;
 *   2. callbacks keep working and the session stays open until `Run` settles; `run` settles only then;
 *   3. when `Run` has not settled `cancelGraceMs` after the abort, the `Run` call is cancelled and
 *      `context.log.warn('The executor did not end a cancelled run.', {code: 'executor_cancel_timeout'})` is
 *      written once; the session ends when the cancelled call settles (a later callback: `unknown_session`).
 *   Once `call.signal` aborted, `run` rejects with `call.signal.reason` whatever `Run` answered — `{text}`
 *   included — so `agent.cancelled`'s `error` is the prompt's abort reason, as in process; a session failure
 *   still wins in the runner (`session.failure ?? error`, `runner.ts:546`). The grace timer is cleared when `Run`
 *   settles and is `unref`ed.
 * - `compact({thread, session, policy}, call)` → `Compact{sessionId, thread, policy}`, cancelled the same way
 *   (steps 1–3, the same grace and warning, message 'The executor did not end a cancelled compaction.', code
 *   `executor_cancel_timeout`). Once `call.signal` aborted: a `Compact` that resolves is parsed and answered as
 *   before (a `{status: 'failed', code}` included — as in process, where the compaction answers after its abort);
 *   one that rejects rejects with `call.signal.reason` (the session's failure still wins in the runner,
 *   `runner.ts:1248-1251`). `checkpoint` and `rewind` keep cancel-by-abort.
 * - Without `call` (or a `CallOptions` with no signal), as before. An executor that never opens `WatchCancel`
 *   (or one whose stream failed) is cancelled at the grace: the run's last `Record` may then be lost, as before.
 * - Instance gone or drained: a `Run` pinned to a lost instance fails `generation_lost` (or `unavailable`) as
 *   before; the session ends when it settles; a pending grace timer is cleared. A drain of `default` keeps the
 *   `Run` and its `WatchCancel` on the draining instance (both pinned), so a cancel during a drain still arrives.
 */
export const routedExecutor = (
  context: Pick<HostContext, 'services' | 'registrations' | 'log'>,
  sessions: ExecutorSessions,
  options: RoutedExecutorOptions = {},
): RuntimePorts['executor'] => {
  const { services, registrations, log } = context;
  const graceMs = options.cancelGraceMs ?? executorCancelGraceMs;
  /** The provider bundle of `executor/v1`, read at the first session. */
  const provider = cached(() =>
    routed(async () => {
      const { catalogSnapshot } = await services.use(CatalogService).get({});
      const bundleId = catalogSnapshot?.contracts.find(
        ({ id }) => id === EXECUTOR_CONTRACT,
      )?.providers[0]?.bundleId;
      if (bundleId === undefined)
        throw new ContractError(
          'unavailable',
          `No bundle provides ${EXECUTOR_CONTRACT}.`,
        );
      return bundleId;
    }),
  );
  /** The formats of the current provider instance, tracked for its replays. */
  const formats = cached(() =>
    routed(async () => {
      const tracked = await registrations.track(
        ExecutorService,
        async (client) => (await client.formats({})).formats,
        {
          onReplayed: (next) => {
            formats.set(next);
            provider.forget();
          },
        },
      );
      return tracked.current;
    }),
  );

  /** Runs `work` with a session open for `callbacks`, ended once `work` settled. */
  const withSession = <T>(
    callbacks: SessionCallbacks,
    work: (opened: OpenedExecutorSession) => Promise<T>,
  ): Promise<T> =>
    routed(async () => {
      const opened = sessions.open(await provider.get(), callbacks);
      try {
        return await work(opened);
      } finally {
        opened.end();
      }
    });

  /**
   * Makes `request` with a signal of its own: when `call`'s signal aborts, `opened` is cancelled and the request is
   * cancelled only `graceMs` later (one `executor_cancel_timeout` warning, `message`). Once `call`'s signal aborted,
   * a failure is answered as its reason. Without a signal, as before.
   */
  const cancelledThroughSession = async <T>(
    opened: OpenedExecutorSession,
    call: CallArg | undefined,
    message: string,
    request: (options: { readonly signal?: AbortSignal }) => Promise<T>,
  ): Promise<T> => {
    const signal = call?.signal;
    if (signal === undefined) return request({});
    const own = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      opened.cancel();
      timer = setTimeout(() => {
        log.warn(message, { code: 'executor_cancel_timeout' });
        own.abort(signal.reason);
      }, graceMs);
      timer.unref();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await request({ signal: own.signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  };

  return (scope) => {
    const client = () => services.use(ExecutorService, { scope });
    const optionsOf = (call: CallArg | undefined) =>
      call?.signal === undefined ? {} : { signal: call.signal };
    const threadOf = (thread: ExecutorThread) =>
      encode(ExecutorThreadSchema, thread, runtimeOneofs);

    return {
      run: ({ thread, job, session }, call) =>
        withProviderErrors(
          withSession(session, async (opened) => {
            const answered = await cancelledThroughSession(
              opened,
              call,
              'The executor did not end a cancelled run.',
              (options) =>
                client().run(
                  {
                    sessionId: opened.id,
                    thread: threadOf(thread),
                    job: encode(PromptJobSchema, job, runtimeOneofs),
                  },
                  options,
                ),
            );
            if (call?.signal?.aborted) throw call.signal.reason;
            return { text: answered.text };
          }),
        ),
      compact: ({ thread, session, policy }, call) =>
        withProviderErrors(
          withSession(session, async (opened) => {
            const response = await cancelledThroughSession(
              opened,
              call,
              'The executor did not end a cancelled compaction.',
              (options) =>
                client().compact(
                  { sessionId: opened.id, thread: threadOf(thread), policy },
                  options,
                ),
            );
            const parsed = executorMethods.compact.output.safeParse(
              decode(CompactResponseSchema, response, runtimeOneofs),
            );
            if (!parsed.success)
              throw new ContractError(
                'invalid_output',
                `executor/v1.Compact answered outside its schema: ${parsed.error.message}`,
              );
            return parsed.data as ExecutorCompactionResult;
          }),
        ),
      checkpoint: ({ history, promptId }, call) =>
        withSession({ history }, async ({ id: sessionId }) => {
          const patch = await historyPatchOf(
            client().checkpoint({ sessionId, promptId }, optionsOf(call)),
          );
          if (patch === undefined)
            throw new ContractError(
              'invalid_output',
              'executor/v1.Checkpoint answered no history.',
            );
          return patch;
        }),
      rewind: ({ history, promptId, removedPromptIds }, call) =>
        withSession({ history }, ({ id: sessionId }) =>
          historyPatchOf(
            client().rewind(
              { sessionId, promptId, removedPromptIds: [...removedPromptIds] },
              optionsOf(call),
            ),
          ),
        ),
      formats: () => formats.get(),
    };
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `error` as llms' `ProviderErrorObject` is shaped when it is `provider_error`
 * with valid `details.providerError`; any other failure unchanged.
 */
const providerErrorOf = (error: unknown): unknown => {
  if (!isContractError(error) || error.code !== 'provider_error') return error;
  const data = isRecord(error.details)
    ? error.details.providerError
    : undefined;
  if (
    !isRecord(data) ||
    typeof data.provider !== 'string' ||
    typeof data.code !== 'string' ||
    typeof data.message !== 'string'
  )
    return error;
  return Object.assign(new Error(data.message), {
    name: 'ProviderError',
    data,
  });
};

/** `work`, its failure rebuilt as {@link providerErrorOf} does. */
const withProviderErrors = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    throw providerErrorOf(error);
  }
};

/**
 * `load()`'s answer, loaded at the first `get` and shared by concurrent ones;
 * a rejected load is not kept (the next `get` loads again).
 */
const cached = <T>(load: () => Promise<T>) => {
  let held: Promise<T> | undefined;
  return {
    get: (): Promise<T> => {
      if (held !== undefined) return held;
      const pending = load();
      held = pending;
      pending.catch(() => {
        if (held === pending) held = undefined;
      });
      return pending;
    },
    /** Replaces the answer. */
    set: (value: T) => {
      held = Promise.resolve(value);
    },
    /** Forgets the answer: the next `get` loads again. */
    forget: () => {
      held = undefined;
    },
  };
};
