/** The thread capabilities one active parent prompt reaches through `host.threads`.
 *
 * Implementations bind every method to the caller's own prompt lifetime and to
 * direct children of the caller's thread in the same project; model-supplied
 * identity never widens that scope.
 */
export interface ThreadControl {
  spawn(prompt: string): Promise<SpawnedThread>;
  list(limit: number, cursor?: string): Promise<ThreadPage>;
  get(threadId: string, afterSequence: number): Promise<ThreadDetail>;
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

export interface ThreadPage {
  readonly items: readonly ThreadView[];
  readonly nextCursor?: string;
}

export interface ThreadDetail {
  readonly thread: ThreadView;
  readonly events: readonly ThreadEventView[];
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
