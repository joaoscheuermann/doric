// Reading a Thread's whole log from the caller's side (S62b): `ThreadEvents`
// answers at most 3 MiB per call, so a caller that needs every event pages.

import { create } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';

import {
  type ThreadEventLog,
  ThreadEventLogSchema,
  type ThreadsService,
} from './gen/doric/runtime/threads/v1/threads_pb.js';

/**
 * Every event of Thread `request.id` after `request.afterSequence`, in order,
 * read through `threads.threadEvents` page by page: each next call's
 * `afterSequence` is the previous page's last sequence, until a page is empty
 * or ends at (or after) its `lastSequence`. Answers one `ThreadEventLog` with
 * the pages' events joined (no event twice, none skipped) and the largest
 * `lastSequence` read, or `undefined` when a page answers no log (no Thread by
 * that id, also when it was deleted between pages). Against a provider that
 * does not cut, it makes exactly one call. Each call carries `options.signal`
 * (default none) and inherits the handler call it is made from.
 *
 * Fails with:
 * - a call's failure, unchanged as the client SDK raises it;
 * - `invalid_output` when a page's last sequence is not after its cursor
 *   (a provider that does not advance), so the loop always ends.
 */
export const readThreadEventLog = async (
  threads: Pick<Client<typeof ThreadsService>, 'threadEvents'>,
  request: { readonly id: string; readonly afterSequence: number },
  options: { readonly signal?: AbortSignal } = {},
): Promise<ThreadEventLog | undefined> => {
  const events: ThreadEventLog['events'] = [];
  let lastSequence = 0;
  let cursor = request.afterSequence;
  for (;;) {
    const { threadEventLog: page } = await threads.threadEvents(
      { id: request.id, afterSequence: cursor },
      { signal: options.signal },
    );
    if (page === undefined) return undefined;
    events.push(...page.events);
    lastSequence = Math.max(lastSequence, page.lastSequence);
    const last = page.events.at(-1)?.sequence;
    if (last === undefined) break;
    if (last <= cursor)
      throw new ContractError(
        'invalid_output',
        `runtime.threads/v1 ThreadEvents did not advance after sequence ${cursor}.`,
      );
    if (last >= page.lastSequence) break;
    cursor = last;
  }
  return create(ThreadEventLogSchema, { events, lastSequence });
};
