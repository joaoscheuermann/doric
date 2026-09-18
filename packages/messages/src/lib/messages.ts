import type { ProviderFinished, ProviderMessage } from 'llms';

export type MessageStorageEntry = ProviderMessage | ProviderFinished;

export type MessageStorage = {
  list(): readonly ProviderMessage[];

  push(entry: MessageStorageEntry): number;
};

const isFinished = (entry: MessageStorageEntry): entry is ProviderFinished =>
  'finishReason' in entry;

const assistant = (turn: ProviderFinished): ProviderMessage => {
  const content =
    turn.text.length > 0 ? turn.text : (turn.refusal ?? turn.text);
  const toolCalls =
    turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {};

  return {
    role: 'assistant',
    content,
    ...toolCalls,
    ...(turn.replay === undefined ? {} : { replay: turn.replay }),
  };
};

/** Creates in-memory provider-ready conversation history storage. */
export const createMessageStorage = (
  initial: readonly ProviderMessage[] = [],
): MessageStorage => {
  const entries: ProviderMessage[] = [...initial];

  return {
    list: () => [...entries],
    push(entry) {
      entries.push(isFinished(entry) ? assistant(entry) : entry);

      return entries.length;
    },
  };
};
