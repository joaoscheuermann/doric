/*
 * The streamed deltas an executor may write to a Thread's log as one event.
 * The default executor coalesces consecutive deltas before it records them,
 * and a reader that folds the log (the chat projector) must draw the same
 * transcript from the merged event as from the deltas apart, so this rule is
 * the one both sides share: two deltas merge only when nothing a reader draws
 * can tell them apart from their concatenation.
 */

/** The text-carrying deltas: an answer, its reasoning, a refusal. */
export type TextStreamDelta = {
  readonly type: 'text.delta' | 'reasoning.delta' | 'refusal.delta';
  readonly delta: string;
};

/** A piece of one streamed tool call's arguments, named by its index. */
export type ToolCallStreamDelta = {
  readonly type: 'tool_call.delta';
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsDelta?: string;
};

export type StreamDelta = TextStreamDelta | ToolCallStreamDelta;

const textTypes: readonly string[] = [
  'text.delta',
  'reasoning.delta',
  'refusal.delta',
];

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

/** The value as a stream delta, or undefined when it is any other event. */
export const streamDelta = (value: unknown): StreamDelta | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== 'string') return undefined;
  if (textTypes.includes(event.type))
    return typeof event.delta === 'string'
      ? (value as TextStreamDelta)
      : undefined;
  if (event.type !== 'tool_call.delta') return undefined;
  return Number.isSafeInteger(event.index) &&
    optionalString(event.id) &&
    optionalString(event.name) &&
    optionalString(event.argumentsDelta)
    ? (value as ToolCallStreamDelta)
    : undefined;
};

/**
 * Whether a delta says nothing: no text, or a tool call's piece with no
 * arguments and no identity. A tool call's first piece often carries only
 * its `id` and `name`, which the merged event keeps, so that one is not
 * empty. A reader skips an empty delta, so a writer may drop it.
 */
export const isEmptyDelta = (delta: StreamDelta): boolean =>
  delta.type === 'tool_call.delta'
    ? (delta.argumentsDelta ?? '') === '' &&
      delta.id === undefined &&
      delta.name === undefined
    : delta.delta.length === 0;

const blank = (text: string): boolean => text.trim().length === 0;

/** Two optional names agree when either is absent or both are the same. */
const agree = (left?: string, right?: string): boolean =>
  left === undefined || right === undefined || left === right;

/**
 * The one delta `left` followed by `right` reads as, or undefined when they
 * must stay two events: different kinds, different tool calls, or answer text
 * whose blank start would join the first words that follow it. A reader does
 * not open an answer on blank text alone, so blank text kept apart is dropped
 * where it would be, while merged it would start the answer.
 */
export const mergeDeltas = (
  left: StreamDelta,
  right: StreamDelta,
): StreamDelta | undefined => {
  if (left.type === 'tool_call.delta' || right.type === 'tool_call.delta') {
    if (left.type !== 'tool_call.delta' || right.type !== 'tool_call.delta')
      return undefined;
    if (
      left.index !== right.index ||
      !agree(left.id, right.id) ||
      !agree(left.name, right.name)
    )
      return undefined;
    const id = left.id ?? right.id;
    const name = left.name ?? right.name;
    const pieces =
      left.argumentsDelta === undefined && right.argumentsDelta === undefined
        ? undefined
        : `${left.argumentsDelta ?? ''}${right.argumentsDelta ?? ''}`;
    return {
      ...left,
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
      ...(pieces === undefined ? {} : { argumentsDelta: pieces }),
    };
  }
  if (left.type !== right.type) return undefined;
  if (left.type === 'text.delta' && blank(left.delta) && !blank(right.delta))
    return undefined;
  return { ...left, delta: `${left.delta}${right.delta}` };
};
