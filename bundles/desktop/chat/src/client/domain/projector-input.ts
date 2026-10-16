import type { TurnComment } from '../../contracts/index.js';
import { delegatedInput } from './delegated.js';
import type { Draft } from './projector.js';
import { promptMessage, promptSummary } from './prompt-envelope.js';
import type { QueueItem } from './queue.js';
import type { ThreadEvent } from './workspace.js';

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

/**
 * The words a reader's prompt shows: the envelope's `<message>` (its comments
 * are the turn's margin, drawn from `comments.added/v1`), or the plain text of
 * a prompt written before the envelope. Other sources show their text as is.
 */
const shownText = (input: PromptInput): string =>
  input.source.kind === 'user' ? promptMessage(input.text) : input.text;

/** Legacy logs render at acceptance; new logs render the full input at dispatch. */
export const readInput = (
  inputs: Map<string, PromptInput>,
  comments: ReadonlyMap<string, readonly TurnComment[]>,
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
      // A receipt has no margin of its own, so a prompt of comments alone
      // reads as its notes.
      items: [
        {
          promptId: item.promptId,
          text:
            input.source.kind === 'user'
              ? promptSummary(input.text)
              : input.text,
          source: input.source,
        },
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
    text: delegated === undefined ? shownText(input) : '',
    accepted: true,
    // The comments the log wrote below this input — the flush of a send —
    // are the margin of the words it carries: they render above them, the
    // same lines the stack drew before the reader sent.
    comments: [...(comments.get(item.promptId) ?? [])],
    awaiting: false,
    ...(delegated === undefined ? {} : { delegated }),
  };
};

/** Acceptance, not the later execution block, acknowledges an optimistic send. */
export const acceptedHumanInputs = (
  inputs: ReadonlyMap<string, PromptInput>,
): number =>
  [...inputs.values()].filter((input) => input.source.kind === 'user').length;
