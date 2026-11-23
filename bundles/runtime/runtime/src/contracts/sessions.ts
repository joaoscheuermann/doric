// Thread sessions from the caller's side (RK15): `withThreadSession` opens one
// over `runtime.workspace/v1.OpenThread`, runs a task, and ends it.

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';

import type {
  OpenThreadRequestSchema,
  WorkspaceService,
} from './gen/doric/runtime/workspace/v1/workspace_pb.js';

/** An open Thread session: `OpenThread`'s `ready` item. */
export interface OpenedThreadSession {
  /** The id `ThreadState` and `LeaseTarget.threadSessionId` take; valid for this instance only. */
  readonly threadSessionId: string;
  readonly projectId: string;
  readonly threadId: string;
  /** The Thread's working directory when the session opened. */
  readonly cwd: string;
  /** The sandbox the session runs on. */
  readonly sandboxId: string;
}

/** A session task's outcome: its value, or why no session opened (today's `ThreadTaskOutcome`). */
export type ThreadSessionOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'missing' | 'inactive' | 'pending' };

/**
 * Runs `task` while one Thread session is open, the only way a caller opens
 * one (RK15).
 *
 * Opens `runtime.workspace/v1.OpenThread(request)` through `workspace`, with
 * `options.signal` (default none) added to the call's own; the call inherits
 * the handler call it is made from, as every client call does. Then, on the
 * first item:
 * - `ready`: runs `task(session)` and resolves `{status: 'ready', value}` with
 *   what it resolves;
 * - `missing`, `inactive` or `pending`: resolves `{status}` and runs nothing.
 *
 * The session ends (the stream is cancelled) when the task settles, whether
 * it resolves or rejects, and before the returned promise settles. A process
 * the task started on the session keeps running.
 *
 * Fails with:
 * - the stream's failure before its first item, unchanged as `contractErrorOf`
 *   reads it (`invalid_input`, `unavailable`, `undeclared_requirement`, …);
 * - `invalid_output` when the stream ends with no item;
 * - the task's rejection, unchanged.
 *
 * A failure of the stream after `ready` (the session ended under the task,
 * e.g. `shutting_down`) does not interrupt the task; the task's later lease
 * operations fail `unknown_session`. When `options.signal` aborts before the
 * first item, the call rejects with the cancellation and no task runs.
 */
export const withThreadSession = async <T>(
  workspace: Pick<Client<typeof WorkspaceService>, 'openThread'>,
  request: MessageInitShape<typeof OpenThreadRequestSchema>,
  task: (session: OpenedThreadSession) => Promise<T>,
  options?: { readonly signal?: AbortSignal },
): Promise<ThreadSessionOutcome<T>> => {
  const session = new AbortController();
  const signal =
    options?.signal === undefined
      ? session.signal
      : AbortSignal.any([session.signal, options.signal]);
  try {
    const stream = workspace.openThread(request, { signal });
    const first = await stream[Symbol.asyncIterator]().next();
    if (first.done === true)
      throw new ContractError(
        'invalid_output',
        'OpenThread ended with no item.',
      );
    const { status } = first.value;
    if (status.case !== 'ready') {
      if (status.case === undefined)
        throw new ContractError(
          'invalid_output',
          'OpenThread answered an item with no status.',
        );
      return { status: status.case };
    }
    const { threadSessionId, projectId, threadId, cwd, sandboxId } =
      status.value;
    const value = await task({
      threadSessionId,
      projectId,
      threadId,
      cwd,
      sandboxId,
    });
    return { status: 'ready', value };
  } finally {
    session.abort();
  }
};
