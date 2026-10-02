/** The thread capabilities one active parent prompt reaches through `host.threads`.
 *
 * Implementations bind every method to the caller's own prompt lifetime and to
 * direct children of the caller's thread in the same project; model-supplied
 * identity never widens that scope.
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

/** A child thread record as it crosses the host boundary. */
export interface ThreadView {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly name: string;
  readonly state: string;
  readonly lastSequence: number;
  readonly activePromptId?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/** A persisted child event as it crosses the host boundary. */
export interface ThreadEventView {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
}

/** The final result of the most recent finished prompt, as the host materializes it. */
export interface ThreadResult {
  readonly status: string;
  readonly text: string;
  readonly promptId: string;
  readonly at: string;
}

export interface ThreadPage {
  readonly items: readonly ThreadView[];
  readonly nextCursor?: string;
}

/**
 * A child's state and, when one exists, the result of its most recent finished
 * prompt. It is a cheap read: the result is stored on the thread rather than
 * reconstructed from its events, so inspecting a finished child never carries
 * its transcript.
 */
export interface ThreadSummary {
  readonly thread: ThreadView;
  readonly result?: ThreadResult;
}

/** A bounded page of a child's persisted events, with the next exclusive cursor. */
export interface ThreadEventsPage {
  readonly events: readonly ThreadEventView[];
  readonly nextSequence?: number;
}

export interface SpawnedThread {
  readonly threadId: string;
  readonly promptId: string;
}

export type PromptResult =
  | { readonly status: 'accepted'; readonly promptId: string }
  | { readonly status: 'missing' | 'inactive' };

export type InterruptResult =
  | 'interrupted'
  | 'missing'
  | 'inactive'
  | 'not_running';
