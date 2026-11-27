// The two boundaries `comments`' registry reaches (phase 3, S52a): the Thread
// log it folds and the event writer it appends to. The host part binds them
// over the router (`routedCommentsPorts`, `./routed.ts`); the registry and
// `comment_reply` are written once, over the ports.

import type { Call } from 'bundle/contracts';
import type { ThreadEvent } from 'runtime/contracts';

import type {
  CommentsAddedPayload,
  CommentsResolvedPayload,
} from '../contracts/index.js';

/**
 * The two boundaries the registry reaches: the Thread log it folds and the
 * event writer it appends to. Every method runs under `call` (its scope,
 * deadline and signal) and rejects with the provider's `ContractError`; no
 * method retries or caches.
 */
export interface CommentsPorts {
  /**
   * Every row of Thread `threadId`'s log, from its first event, in log order,
   * as `runtime.threads/v1` holds them (`event` is the stored JSON body);
   * `[]` when no Thread has that id.
   */
  threadEvents(threadId: string, call: Call): Promise<readonly ThreadEvent[]>;
  /** The ids of every Thread of Project `projectId`, `createdAt` then id ascending. */
  projectThreadIds(projectId: string, call: Call): Promise<readonly string[]>;
  /**
   * Appends one `comments.added/v1` row to the call's Thread; resolves once the
   * row is written. On rejection nothing was written (`invalid_scope`,
   * `unknown_event`, `not_owner`, `invalid_input`, `unavailable`).
   */
  appendAdded(payload: CommentsAddedPayload, call: Call): Promise<void>;
  /** As {@link CommentsPorts.appendAdded}, for `comments.resolved/v1`. */
  appendResolved(payload: CommentsResolvedPayload, call: Call): Promise<void>;
}
