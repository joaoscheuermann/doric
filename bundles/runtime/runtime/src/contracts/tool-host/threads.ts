import type {
  InterruptResult,
  PromptResult,
  SpawnedThread,
  ThreadEventsPage,
  ThreadPage,
  ThreadSummary,
  ThreadView,
} from '../threads.js';

/** The thread capabilities one active parent prompt reaches through `host.threads`.
 *
 * Implementations bind every method to the caller's own prompt lifetime and to
 * direct children of the caller's thread in the same project; model-supplied
 * identity never widens that scope. The record and result types are the
 * `runtime.threads/v1` contract's own types.
 */
export interface ThreadControl {
  spawn(prompt: string): Promise<SpawnedThread>;
  list(limit: number, cursor?: string): Promise<ThreadPage>;
  /** The child's state and, when a prompt has finished, its materialized result. */
  get(threadId: string): Promise<ThreadSummary>;
  /** A bounded, forward page of the child's persisted events after a cursor. */
  events(
    threadId: string,
    afterSequence: number,
    limit: number,
  ): Promise<ThreadEventsPage>;
  send(threadId: string, prompt: string): Promise<PromptResult>;
  interrupt(threadId: string, promptId: string): Promise<InterruptResult>;
  terminate(threadId: string): Promise<ThreadView>;
}
