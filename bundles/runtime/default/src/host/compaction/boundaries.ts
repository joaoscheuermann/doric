import type { ProviderMessage } from 'llms';

/*
 * Tool-pairing boundaries (the compaction contract's toolPairingBalanced
 * checks, on the provider-ready array instead of an event sequence): a cut
 * between `messages[index - 1]` and `messages[index]` is safe when no
 * assistant tool call has its request on one side and its result on the
 * other. Splitting such a pair leaves a provider-invalid history — a call
 * the model made answered by a result the call never produced.
 */

const callIds = (message: ProviderMessage): readonly string[] =>
  message.role === 'assistant'
    ? (message.toolCalls ?? []).map((call) => call.id)
    : [];

const resultIds = (message: ProviderMessage): readonly string[] =>
  message.role === 'tool' && message.toolCallId !== undefined
    ? [message.toolCallId]
    : [];

/**
 * Every safe cut of the history, in index order: index 0 (condense
 * everything) is always safe, and an index is safe when the open-call set is
 * empty across the cut. A `tool` result whose call is already missing is
 * corrupt history: the scan stops there and no further cut is reported,
 * rather than one that would present a result without its call.
 */
export const safeBoundaries = (
  messages: readonly ProviderMessage[],
): readonly number[] => {
  const open = new Set<string>();
  const boundaries: number[] = [0];
  let corrupt = false;
  for (let index = 0; index < messages.length && !corrupt; index += 1) {
    const message = messages[index] as ProviderMessage;
    for (const id of resultIds(message)) corrupt ||= !open.delete(id);
    for (const id of callIds(message)) open.add(id);
    if (corrupt) break;
    if (open.size === 0) boundaries.push(index + 1);
  }
  return boundaries;
};

/**
 * Whether one cut is safe: no unanswered assistant tool call crosses it.
 * Repeated checks read the history once per call, like the contract's
 * cached reads do for one cut.
 */
export const isSafeBoundary = (
  messages: readonly ProviderMessage[],
  index: number,
): boolean =>
  Number.isInteger(index) &&
  index >= 0 &&
  index <= messages.length &&
  safeBoundaries(messages).includes(index);

/**
 * The largest safe cut at or before `limit`, or undefined when none fits —
 * the tail the caller wants to keep has no safe boundary, which the
 * automatic trigger reads as "cannot condense" rather than splitting a pair.
 */
export const largestSafeBoundaryAtOrBefore = (
  messages: readonly ProviderMessage[],
  limit: number,
): number | undefined => {
  let largest: number | undefined;
  for (const boundary of safeBoundaries(messages)) {
    if (boundary > limit) break;
    largest = boundary;
  }
  return largest;
};
