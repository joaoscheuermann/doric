import type {
  InterruptResult,
  Page,
  PromptResult,
  Thread,
  ThreadEvent,
} from './types.js';

/** Capabilities bound to one active parent prompt, never to model-supplied identity. */
export interface ThreadCoordination {
  spawn(
    prompt: string,
  ): Promise<{ readonly threadId: string; readonly promptId: string }>;
  list(limit: number, cursor?: string): Promise<Page<Thread>>;
  get(
    threadId: string,
    afterSequence: number,
  ): Promise<{
    readonly thread: Thread;
    readonly events: readonly ThreadEvent[];
  }>;
  send(threadId: string, prompt: string): Promise<PromptResult>;
  interrupt(threadId: string, promptId: string): Promise<InterruptResult>;
  terminate(threadId: string): Promise<Thread>;
}
