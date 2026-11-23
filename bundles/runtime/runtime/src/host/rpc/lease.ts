// `runtime.lease/v1` over the router (phase 3, slice S47a): the sandbox
// operations of a Project lease, a prompt's bound sandbox or a Thread
// session's sandbox, run in the incoming call.

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf, isContractError } from 'bundle/contracts';
import type { Sandbox, SandboxProcess } from 'sandbox';
import { chunkBytes, joinChunks } from 'storage/rpc';

import type {
  LeaseService,
  LeaseTarget,
  StartResponseSchema,
} from '../../contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { type LeaseOutcome, leaseScopeMessage } from '../../contracts/lease.js';
import { readRuntimeScope } from '../../contracts/scope.js';
import type { RuntimeCore } from '../index.js';
import { callerInstanceOf, type ThreadSessions } from '../sessions.js';
import { routed, routedError } from './errors.js';
import {
  diffInputOf,
  execInputOf,
  execResultMessage,
  processInputOf,
  sshMessage,
  statsMessage,
} from './sandbox.js';
import { routedItems, streamOf } from './streams.js';

/** The `leaseStatus` of an `UNAVAILABLE` lease failure: today's non-ready outcomes. */
export type LeaseStatus = Exclude<LeaseOutcome<unknown>['status'], 'ready'>;

/**
 * `ContractError('unavailable', message, { leaseStatus })`: the JSON form of
 * `runtime.lease.v1.ErrorDetails`. `message` defaults to today's
 * `Project lease is not ready (<status>).`
 */
export const leaseUnavailable = (
  leaseStatus: LeaseStatus,
  message = `Project lease is not ready (${leaseStatus}).`,
): ContractError => new ContractError('unavailable', message, { leaseStatus });

/**
 * `error` as {@link routedError} reads it, except a `sandbox/v1`
 * `unknown_lease` (the lease was released under the operation), which is
 * `leaseUnavailable('unavailable')`.
 */
const leaseError = (error: unknown): unknown => {
  const routedFailure = routedError(error);
  return isContractError(routedFailure) &&
    routedFailure.code === 'unknown_lease'
    ? leaseUnavailable('unavailable')
    : routedFailure;
};

/** Runs `work`, rethrowing its failure as {@link leaseError} does. */
const leased = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await routed(work);
  } catch (error) {
    throw leaseError(error);
  }
};

/** Every item of `source()`, its failure rethrown as {@link leaseError} does. */
async function* leasedItems<T>(
  source: () => AsyncIterable<T>,
): AsyncGenerator<T> {
  try {
    yield* routedItems(source);
  } catch (error) {
    throw leaseError(error);
  }
}

/** `value`, which the proto requires, or `invalid_input` when absent. */
const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined)
    throw new ContractError('invalid_input', `runtime.lease/v1 needs ${name}.`);
  return value;
};

type StartItem = MessageInitShape<typeof StartResponseSchema>;

/**
 * `runtime.lease/v1` over `RuntimeCore` and `sessions`. `core()` throws
 * `unavailable` before `activate`.
 *
 * Target (which sandbox), in this order, from `request.target` (`head.target`
 * for `Start`/`PutFile`) and `callOf(context)`:
 * 1. `threadSessionId` set: `sessions.get(id, callerInstanceOf(context)).sandbox`
 *    (`unknown_session` otherwise), whatever the scope.
 * 2. scope `promptId`: `bindings.bound(call).sandbox`; an ended prompt fails
 *    `thread_control_inactive` (FAILED_PRECONDITION).
 * 3. scope `projectId`, else the Project of scope `threadId`
 *    (`service.threads.find`; an unknown Thread is `leaseStatus: 'missing'`):
 *    `service.projects.withLease`, never acquiring. A non-ready outcome fails
 *    `leaseUnavailable(status)`.
 * 4. none: `invalid_input`, `leaseScopeMessage` (no "first active Project"
 *    fallback, as the proto says).
 *
 * `expectSandboxId` set and ≠ the resolved `sandbox.id`: fails
 * `leaseUnavailable('unavailable', 'Sandbox <expected> is no longer the
 * lease\'s sandbox.')` and makes no `sandbox/v1` call.
 *
 * Operations, on the resolved `Sandbox`:
 * - `Describe` → `{id, root}`; `Exec` → `exec({...execInputOf(request),
 *   signal: context.signal})`; `ReadFile` → `readFile`; `WriteFile` →
 *   `writeFile`; `Diff` → `diff(request && diffInputOf(request))`; `Stats` →
 *   `stats?.()` (no `response` when absent or undefined); `Ssh` →
 *   `{vmId: sandbox.id, response?}`.
 * - `ReadFileBytes`, `GetFile` → `getFile`, answered as `chunkBytes` (≤ 1 MiB
 *   items; none for an empty file).
 * - `PutFile`: the first item must be `head`, every later item a `chunk`;
 *   otherwise `invalid_input` and no sandbox call. The target is resolved at
 *   the head; the joined bytes are written once, after the client's
 *   half-close, with `putFile`.
 * - `Start`: the first item must be `head` (else `invalid_input`, nothing
 *   starts). A sandbox without `start` fails `unsupported_operation`
 *   (UNIMPLEMENTED); so does the provider's. Once `start` resolved, answers
 *   one `started` item; output the process produced before that is answered
 *   after it, in order. Then every later `write`/`resize` is forwarded in
 *   order (a `head` after the first is `invalid_input` and terminates the
 *   process). Answers one `output` item per chunk in order, then one `exit`,
 *   then ends. A failure before `started` means nothing runs. The client's
 *   half-close does not stop the process; cancelling the call terminates it
 *   (`terminate()`); a process started on a session's sandbox keeps running
 *   after the session ends.
 * - Unary operations on a Project target (step 3) run inside `withLease`, so
 *   closing or lease loss during the operation fails
 *   `leaseUnavailable('unavailable')` as today; `Start`, `PutFile`,
 *   `ReadFileBytes` and `GetFile` resolve the sandbox inside it and stream
 *   outside it.
 *
 * The handler runs in the incoming call, not `detached`: each `sandbox/v1`
 * call inherits the caller's deadline, cancellation and trace. An
 * `unknown_lease` from `sandbox/v1` (the lease was released under the
 * operation) fails `leaseUnavailable('unavailable')`; any other failure
 * passes through `routedError`.
 */
export const routedLeaseService = (
  core: () => RuntimeCore,
  sessions: ThreadSessions,
): ServiceImpl<typeof LeaseService> => {
  /**
   * Runs `operation` on the sandbox `target` and the call's scope name (the
   * module comment's steps 1–4), after the `expectSandboxId` check.
   */
  const onSandbox = async <T>(
    context: HandlerContext,
    target: LeaseTarget | undefined,
    operation: (sandbox: Sandbox) => Promise<T>,
  ): Promise<T> => {
    const { service, bindings } = core();
    const checked = (sandbox: Sandbox): Promise<T> => {
      const expected = target?.expectSandboxId;
      if (expected !== undefined && expected !== sandbox.id)
        throw leaseUnavailable(
          'unavailable',
          `Sandbox ${expected} is no longer the lease's sandbox.`,
        );
      return operation(sandbox);
    };
    if (target?.threadSessionId !== undefined)
      return checked(
        sessions.get(target.threadSessionId, callerInstanceOf(context)).sandbox,
      );
    const call = callOf(context);
    const scope = readRuntimeScope(call);
    if (scope.promptId !== undefined)
      return checked(bindings.bound(call).sandbox);
    let projectId = scope.projectId;
    if (projectId === undefined && scope.threadId !== undefined) {
      const thread = await service.threads.find(scope.threadId);
      if (thread === undefined) throw leaseUnavailable('missing');
      projectId = thread.projectId;
    }
    if (projectId === undefined)
      throw new ContractError('invalid_input', leaseScopeMessage);
    const outcome = await service.projects.withLease(projectId, (sandbox) =>
      checked(sandbox),
    );
    if (outcome.status !== 'ready') throw leaseUnavailable(outcome.status);
    return outcome.value;
  };

  /** The sandbox `target` names, picked inside `withLease`, for a stream run outside it. */
  const sandboxOf = (
    context: HandlerContext,
    target: LeaseTarget | undefined,
  ): Promise<Sandbox> => onSandbox(context, target, async (sandbox) => sandbox);

  /** The file at `path` as items of at most 1 MiB (none for an empty file). */
  const fileItems = (
    context: HandlerContext,
    target: LeaseTarget | undefined,
    path: string,
  ) =>
    leasedItems(async function* () {
      const sandbox = await sandboxOf(context, target);
      for (const chunk of chunkBytes(await sandbox.getFile(path)))
        yield { chunk };
    });

  return {
    describe: ({ target }, context) =>
      leased(() =>
        onSandbox(context, target, async ({ id, root }) => ({ id, root })),
      ),
    exec: ({ target, request }, context) =>
      leased(() =>
        onSandbox(context, target, async (sandbox) => ({
          response: execResultMessage(
            await sandbox.exec({
              ...execInputOf(required(request, 'a request')),
              signal: context.signal,
            }),
          ),
        })),
      ),
    readFile: ({ target, request }, context) =>
      leased(() =>
        onSandbox(context, target, async (sandbox) => ({
          response: {
            content: await sandbox.readFile(
              required(request, 'a request').path,
            ),
          },
        })),
      ),
    readFileBytes: ({ target, request }, context) =>
      fileItems(context, target, required(request, 'a request').path),
    writeFile: ({ target, request }, context) =>
      leased(() =>
        onSandbox(context, target, async (sandbox) => {
          const { path, content } = required(request, 'a request');
          await sandbox.writeFile(path, content);
          return {};
        }),
      ),
    ssh: ({ target }, context) =>
      leased(() =>
        onSandbox(context, target, async (sandbox) => {
          const access = await sandbox.ssh();
          return {
            vmId: sandbox.id,
            ...(access === undefined ? {} : { response: sshMessage(access) }),
          };
        }),
      ),
    diff: ({ target, request }, context) =>
      leased(() =>
        onSandbox(context, target, async (sandbox) => ({
          response: {
            diff: await sandbox.diff(
              request === undefined ? undefined : diffInputOf(request),
            ),
          },
        })),
      ),
    stats: ({ target }, context) =>
      leased(() =>
        onSandbox(context, target, async (sandbox) => {
          const stats = await sandbox.stats?.();
          return stats === undefined ? {} : { response: statsMessage(stats) };
        }),
      ),
    getFile: ({ target, request }, context) =>
      fileItems(context, target, required(request, 'a request').path),
    putFile: (requests, context) =>
      leased(async () => {
        let file:
          | { readonly sandbox: Sandbox; readonly path: string }
          | undefined;
        const chunks: Uint8Array[] = [];
        for await (const { item } of requests) {
          if (file === undefined) {
            if (item.case !== 'head')
              throw new ContractError(
                'invalid_input',
                'A PutFile stream begins with one head.',
              );
            file = {
              sandbox: await sandboxOf(context, item.value.target),
              path: required(item.value.request, 'a request').path,
            };
          } else if (item.case === 'chunk') chunks.push(item.value);
          else
            throw new ContractError(
              'invalid_input',
              'A PutFile stream carries one head, then chunks.',
            );
        }
        if (file === undefined)
          throw new ContractError(
            'invalid_input',
            'A PutFile stream begins with one head.',
          );
        await file.sandbox.putFile(file.path, joinChunks(chunks));
        return {};
      }),
    start: (requests, context) =>
      leasedItems(async function* () {
        const iterator = requests[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done === true || first.value.item.case !== 'head')
          throw new ContractError(
            'invalid_input',
            'A Start stream begins with one head.',
          );
        const { target, request } = first.value.item.value;
        const input = processInputOf(required(request, 'a request'));
        const sandbox = await sandboxOf(context, target);
        if (sandbox.start === undefined)
          throw new ContractError(
            'unsupported_operation',
            `Sandbox ${sandbox.id} does not support live processes.`,
          );
        const start = sandbox.start.bind(sandbox);
        yield* streamOf<StartItem>((sink) => {
          let process: SandboxProcess | undefined;
          let exited = false;
          /** Forwards every later write and resize, in order. */
          const forward = async (running: SandboxProcess) => {
            for (;;) {
              const next = await iterator.next();
              if (next.done === true || exited) return;
              const { item } = next.value;
              if (item.case === 'write') await running.write(item.value);
              else if (item.case === 'resize')
                await running.resize(item.value.cols, item.value.rows);
              else if (item.case === 'head') {
                sink.end(
                  new ContractError(
                    'invalid_input',
                    'A Start stream carries one head, then writes and resizes.',
                  ),
                );
                await running.terminate();
                return;
              }
            }
          };
          void (async () => {
            /** Output produced before `start` resolved, answered after `started`. */
            let early: StartItem[] | undefined = [];
            process = await start({
              ...input,
              onOutput: (output) => {
                const item: StartItem = {
                  item: { case: 'output', value: output },
                };
                if (early === undefined) sink.next(item);
                else early.push(item);
              },
            });
            sink.next({ item: { case: 'started', value: {} } });
            for (const item of early) sink.next(item);
            early = undefined;
            forward(process).catch((error: unknown) => sink.end(error));
            const result = await process.result;
            exited = true;
            sink.next({
              item: { case: 'exit', value: execResultMessage(result) },
            });
            sink.end();
          })().catch((error: unknown) => sink.end(error));
          return {
            dispose: () => {
              if (!exited) process?.terminate().catch(() => undefined);
            },
          };
        }, context.signal);
      }),
  };
};
