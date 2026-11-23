// The executor port over `executor/v1` (phase 3, slice S48b): each call opens
// an executor session the provider calls back through `executor.session/v1`.

import { type CallArg, ContractError } from 'bundle/contracts';
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
  SessionCallbacks,
} from './executor-sessions.js';
import type { RuntimePorts } from './ports.js';
import { decode, encode, runtimeOneofs } from './rpc/codec.js';
import { routed } from './rpc/errors.js';
import { historyPatchOf } from './rpc/history.js';

/** The contract the executor port calls. */
const EXECUTOR_CONTRACT = 'executor/v1';

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
 */
export const routedExecutor = (
  context: Pick<HostContext, 'services' | 'registrations'>,
  sessions: ExecutorSessions,
): RuntimePorts['executor'] => {
  const { services, registrations } = context;
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
    work: (sessionId: string) => Promise<T>,
  ): Promise<T> =>
    routed(async () => {
      const opened = sessions.open(await provider.get(), callbacks);
      try {
        return await work(opened.id);
      } finally {
        opened.end();
      }
    });

  return (scope) => {
    const client = () => services.use(ExecutorService, { scope });
    const optionsOf = (call: CallArg | undefined) =>
      call?.signal === undefined ? {} : { signal: call.signal };
    const threadOf = (thread: ExecutorThread) =>
      encode(ExecutorThreadSchema, thread, runtimeOneofs);

    return {
      run: ({ thread, job, session }, call) =>
        withSession(session, async (sessionId) => {
          const { text } = await client().run(
            {
              sessionId,
              thread: threadOf(thread),
              job: encode(PromptJobSchema, job, runtimeOneofs),
            },
            optionsOf(call),
          );
          return { text };
        }),
      compact: ({ thread, session, policy }, call) =>
        withSession(session, async (sessionId) => {
          const response = await client().compact(
            { sessionId, thread: threadOf(thread), policy },
            optionsOf(call),
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
      checkpoint: ({ history, promptId }, call) =>
        withSession({ history }, async (sessionId) => {
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
        withSession({ history }, (sessionId) =>
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
