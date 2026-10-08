import { resumeAttempt } from './prompt-lifecycle';
import type { ThreadEvent } from './workspace';

type Recovery = {
  readonly event: ThreadEvent;
  readonly attempt: number;
};

/** Recovery enters the queue; only a subsequent agent start resumes execution. */
export type PromptExecution = {
  readonly started: boolean;
  readonly recoveredThrough?: number;
  readonly pending?: Recovery;
};

/** Advance one prompt, returning a recovery only when an earlier execution restarts. */
export const readExecution = (
  executions: Map<string, PromptExecution>,
  item: ThreadEvent,
  event: Record<string, unknown> | undefined,
): Recovery | undefined => {
  const previous = executions.get(item.promptId) ?? { started: false };
  if (event?.type === 'prompt.resumed') {
    const attempt = resumeAttempt(event.attempt);
    if (attempt !== undefined)
      executions.set(item.promptId, {
        ...previous,
        recoveredThrough: item.sequence,
        pending: { event: item, attempt },
      });
  } else if (event?.type === 'agent.started') {
    executions.set(item.promptId, {
      ...previous,
      started: true,
      pending: undefined,
    });
    return previous.started ? previous.pending : undefined;
  } else if (
    event?.type === 'prompt.paused' ||
    event?.type === 'prompt.finished' ||
    event?.type === 'agent.failed' ||
    event?.type === 'agent.cancelled'
  ) {
    executions.set(item.promptId, { ...previous, pending: undefined });
  }
  return undefined;
};
