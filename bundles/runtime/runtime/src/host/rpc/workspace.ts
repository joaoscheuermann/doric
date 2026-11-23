// `runtime.workspace/v1` over the router (phase 3, slice S47b): the calling
// prompt's working directory and Thread sessions bound to the opening
// instance.

import type { DescMessage, MessageInitShape } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { callOf } from 'bundle/contracts';
import type { HostContext } from 'bundle/host';
import type { z } from 'zod';

import {
  CwdResponseSchema,
  LocationResponseSchema,
  type OpenThreadResponseSchema,
  SetCwdResponseSchema,
  type WorkspaceService,
} from '../../contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import { runtimeWorkspaceMethods as methods } from '../../contracts/workspace.js';
import type { RuntimeCore } from '../index.js';
import {
  callerInstanceOf,
  type OpenedSession,
  type ThreadSessions,
} from '../sessions.js';
import { encode } from './codec.js';
import { detached, parseInput, routed } from './errors.js';
import { detachedItems } from './streams.js';

/** `value` parsed by today's input schema of `runtime.workspace/v1.<method>`. */
const input = <S extends z.ZodType>(
  method: string,
  schema: S,
  value: unknown,
): z.output<S> => parseInput(`runtime.workspace/v1 ${method}`, schema, value);

type OpenThreadItem = MessageInitShape<typeof OpenThreadResponseSchema>;

/**
 * `runtime.workspace/v1` over `RuntimeCore` and `sessions`. `core()` throws
 * `unavailable` before `activate`.
 *
 * - `Cwd`, `SetCwd`, `Location`: today's methods on
 *   `bindings.bound(call).host.workspace` (S46 pattern: `parseInput` with
 *   `runtimeWorkspaceMethods.<m>.input`, domain `detached`, `encode`d).
 *   Without a running prompt in scope: `thread_control_inactive`. `SetCwd`
 *   answers `{status, cwd?}` for every outcome.
 * - `OpenThread{threadId, exclusive, resume?, refreshHint?}`: runs
 *   `service.threads.withThread` `detached`, so a resume's acquisition is not
 *   tied to this call. Its task opens a session for
 *   `callerInstanceOf(context)`, yields `{ready: {threadSessionId, projectId,
 *   threadId, cwd, sandboxId: sandbox.id}}`, and returns when the call is
 *   cancelled or the session ends (`dropInstance`, `endAll`). The stream sends
 *   nothing after `ready`; it ends without error on cancellation and fails
 *   with the `endAll` reason. A `missing`/`inactive`/`pending` outcome yields
 *   that one refusal item (`{}`), then ends. While the task runs, `withThread`
 *   holds the Thread live and, with `exclusive`, the Project mutation lock;
 *   its end releases the lock, then, with `refreshHint`, refreshes the hint.
 *   When `withThread` rejects after the session it opened has ended (the
 *   stream already ended), the failure is logged through `log()` at `warn`,
 *   message 'Thread session hint refresh failed', fields `{threadId, err}`,
 *   and is not sent to the (ended) stream (S48b). A rejection before a
 *   session opened still fails the stream. `log()` answers `undefined` before
 *   `activate`; nothing is logged then. A call
 *   cancelled before the task starts opens no session. Domain failures pass
 *   through `routedError`.
 * - `ThreadState{threadSessionId}`: `{closing: closing(), busyCwds:
 *   busyCwds()}` of `sessions.get(id, callerInstanceOf(context))`;
 *   `unknown_session` otherwise.
 */
export const routedWorkspaceService = (
  core: () => RuntimeCore,
  sessions: ThreadSessions,
  log: () => HostContext['log'] | undefined,
): ServiceImpl<typeof WorkspaceService> => {
  /**
   * Runs `work` on the calling prompt's bound workspace, outside the call, and
   * encodes its answer as `schema`.
   */
  const answer = <D extends DescMessage>(
    schema: D,
    context: HandlerContext,
    work: (
      workspace: ReturnType<
        RuntimeCore['bindings']['bound']
      >['host']['workspace'],
    ) => Promise<unknown>,
  ) =>
    routed(async () => {
      const { bindings } = core();
      const call = callOf(context);
      return encode(
        schema,
        await detached(() => work(bindings.bound(call).host.workspace)),
      );
    });

  return {
    cwd: (_request, context) =>
      answer(CwdResponseSchema, context, async (workspace) => {
        input('cwd', methods.cwd.input, []);
        return { cwd: await workspace.cwd() };
      }),
    setCwd: ({ path }, context) =>
      answer(SetCwdResponseSchema, context, (workspace) =>
        workspace.setCwd(input('setCwd', methods.setCwd.input, path)),
      ),
    location: (_request, context) =>
      answer(LocationResponseSchema, context, (workspace) => {
        input('location', methods.location.input, []);
        return workspace.location();
      }),
    openThread: ({ threadId, exclusive, resume, refreshHint }, context) => {
      const owner = callerInstanceOf(context);
      return detachedItems<OpenThreadItem>((sink) => {
        const { service } = core();
        /** The stream ended (cancelled): a task that starts now opens no session. */
        let closed = false;
        let opened: OpenedSession | undefined;
        service.threads
          .withThread(
            threadId,
            {
              exclusive,
              ...(resume === undefined ? {} : { resume }),
              ...(refreshHint === undefined ? {} : { refreshHint }),
            },
            async (thread) => {
              if (closed) return;
              const session = sessions.open(owner, thread);
              opened = session;
              sink.next({
                status: {
                  case: 'ready',
                  value: {
                    threadSessionId: session.id,
                    projectId: thread.projectId,
                    threadId: thread.threadId,
                    cwd: thread.cwd,
                    sandboxId: thread.sandbox.id,
                  },
                },
              });
              // The stream ends as soon as the session does, before the lock
              // is released and the hint refreshed.
              sink.end(await session.ended);
            },
          )
          .then(
            (outcome) => {
              if (outcome.status !== 'ready')
                sink.next({ status: { case: outcome.status, value: {} } });
              sink.end();
            },
            (error: unknown) => {
              // The session's stream already ended: nobody is left to answer.
              if (opened !== undefined) {
                log()?.warn('Thread session hint refresh failed', {
                  threadId,
                  err: error,
                });
                return;
              }
              sink.end(error);
            },
          );
        return {
          dispose: () => {
            closed = true;
            opened?.end();
          },
        };
      }, context.signal);
    },
    threadState: ({ threadSessionId }, context) => {
      const thread = sessions.get(threadSessionId, callerInstanceOf(context));
      return { closing: thread.closing(), busyCwds: [...thread.busyCwds()] };
    },
  };
};
