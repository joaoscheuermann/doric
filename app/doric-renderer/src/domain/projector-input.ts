import { delegatedInput } from './delegated';
import type { Draft } from './projector';
import type { QueueItem } from './queue';
import type { ThreadEvent } from './workspace';

/** Accepted input and its two distinct positions in the conversation. */
export type PromptInput = {
  readonly accepted: ThreadEvent;
  readonly text: string;
  readonly source: QueueItem['source'];
  readonly modern: boolean;
  readonly queued: boolean;
  readonly shown: boolean;
  readonly queuedShown: boolean;
};

const sourceOf = (value: unknown): QueueItem['source'] => {
  if (typeof value !== 'object' || value === null || !('kind' in value))
    return { kind: 'user' };
  if (!['user', 'terminal', 'parent', 'result'].includes(String(value.kind)))
    return { kind: 'user' };
  return value as QueueItem['source'];
};

/** Legacy logs render at acceptance; new logs render the full input at dispatch. */
export const readInput = (
  inputs: Map<string, PromptInput>,
  item: ThreadEvent,
  event: Record<string, unknown> | undefined,
): Extract<Draft, { type: 'user' | 'queued' }> | undefined => {
  if (event?.type === 'prompt.accepted' && !inputs.has(item.promptId)) {
    inputs.set(item.promptId, {
      accepted: item,
      text: typeof event.text === 'string' ? event.text : '',
      source: sourceOf(event.source),
      modern: typeof event.queued === 'boolean',
      queued: event.queued === true,
      shown: false,
      queuedShown: false,
    });
  }
  const input = inputs.get(item.promptId);
  if (input === undefined) return undefined;
  if (
    event?.type === 'prompt.edited' &&
    !input.shown &&
    typeof event.text === 'string'
  ) {
    inputs.set(item.promptId, { ...input, text: event.text });
    return undefined;
  }
  if (event?.type === 'prompt.queued' && !input.queuedShown) {
    inputs.set(item.promptId, { ...input, queuedShown: true });
    return {
      type: 'queued',
      promptId: item.promptId,
      events: [item],
      items: [
        { promptId: item.promptId, text: input.text, source: input.source },
      ],
    };
  }
  if (
    input.shown ||
    !(
      event?.type === 'prompt.started' ||
      (event?.type === 'prompt.accepted' && !input.modern)
    )
  )
    return undefined;
  inputs.set(item.promptId, { ...input, shown: true });
  const delegated = delegatedInput(input.source, input.text);
  return {
    type: 'user',
    promptId: item.promptId,
    events: [item],
    text: delegated === undefined ? input.text : '',
    accepted: true,
    awaiting: false,
    ...(delegated === undefined ? {} : { delegated }),
  };
};

/** Acceptance, not the later execution block, acknowledges an optimistic send. */
export const acceptedHumanInputs = (
  inputs: ReadonlyMap<string, PromptInput>,
): number =>
  [...inputs.values()].filter((input) => input.source.kind === 'user').length;
