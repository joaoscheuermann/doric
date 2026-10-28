import type { ProviderMessage } from 'llms';

import { largestSafeBoundaryAtOrBefore } from './boundaries.js';
import { isCompactionCheckpoint } from './markers.js';

/*
 * The surface rewrite (the contract's one surface mutation): the condensed
 * span [start, end) is replaced by one summary message, followed by the
 * span's retained messages verbatim (`meta.retained`, the standing
 * instructions), and the tail keeps its order. The turn boundaries
 * (`meta.checkpoints`) move with the history — re-based across the removed
 * span, dropped when their prompt was condensed away, which is what makes a
 * rewind to those prompts refuse (`unknown_prompt`) instead of resurfacing
 * content the summary replaced — and so do the retained indexes.
 */

/** Estimate of a text's tokens: ~4 characters per token, explicit estimate. */
export const estimatedTokens = (chars: number): number => Math.floor(chars / 4);

/** What a condensation changed, as the `compaction.finished` payload reads it. */
export interface Condensation {
  readonly start: number;
  readonly end: number;
  readonly condensedMessages: number;
  readonly retainedMessages: number;
  readonly summaryChars: number;
  /** Estimate, not a measurement: the next real usage replaces it. */
  readonly tokensFreed: number;
}

/**
 * The `meta` part of a history: turn boundaries by prompt ID and the length
 * of the stored `messages`. Shape of `default.history/v1`'s meta part.
 */
export interface HistoryMeta {
  readonly checkpoints: Readonly<Record<string, number>>;
  readonly messageCount: number;
  /** The retained messages' indexes by key; absent, nothing is retained. */
  readonly retained?: Readonly<Record<string, number>>;
}

/** The span's retained message indexes, in history order. */
export const keptIndexes = (
  meta: Pick<HistoryMeta, 'retained'>,
  start: number,
  end: number,
): readonly number[] =>
  Object.values(meta.retained ?? {})
    .filter((index) => index >= start && index < end)
    .sort((left, right) => left - right);

/** A retained message a rewrite swaps instead of keeping. */
export interface RetainedReplacement {
  /** its meta.retained key */
  readonly key: string;
  /** placed after the summary and the span's other kept retained messages; absent → the key is removed */
  readonly message?: ProviderMessage;
}

/** The index of the message `replace` swaps when the span holds it, else undefined. */
const swappedIndex = (
  meta: Pick<HistoryMeta, 'retained'>,
  start: number,
  end: number,
  replace?: RetainedReplacement,
): number | undefined => {
  const index =
    replace === undefined ? undefined : meta.retained?.[replace.key];
  return index !== undefined && index >= start && index < end
    ? index
    : undefined;
};

/** The span's retained message indexes a rewrite keeps verbatim: all but the swapped one. */
const keptBy = (
  meta: Pick<HistoryMeta, 'retained'>,
  start: number,
  end: number,
  replace?: RetainedReplacement,
): readonly number[] => {
  const swapped = swappedIndex(meta, start, end, replace);
  return keptIndexes(meta, start, end).filter((index) => index !== swapped);
};

/** How many messages take the span's place: the summary, the kept and the swapped-in one. */
const insertedCount = (
  meta: Pick<HistoryMeta, 'retained'>,
  start: number,
  end: number,
  replace?: RetainedReplacement,
): number =>
  1 +
  keptBy(meta, start, end, replace).length +
  (replace?.message === undefined ? 0 : 1);

/** The span's messages the summarizer condenses: all but the retained ones. */
export const condensedSpan = (
  messages: readonly ProviderMessage[],
  meta: Pick<HistoryMeta, 'retained'>,
  start: number,
  end: number,
): readonly ProviderMessage[] => {
  const kept = new Set(keptIndexes(meta, start, end));
  return messages.slice(start, end).filter((_, at) => !kept.has(start + at));
};

/**
 * The largest safe end of a condensed span that keeps at least `tailMin`
 * messages after it, or undefined when the history has nothing safe to
 * condense: no safe boundary fits inside the span, or the span would be
 * empty. Boundaries at index 0 are never an end — condensing nothing frees
 * nothing.
 */
export const condensibleEnd = (
  messages: readonly ProviderMessage[],
  tailMin: number,
): number | undefined => {
  const limit = Math.max(0, messages.length - Math.max(0, tailMin));
  const boundary = largestSafeBoundaryAtOrBefore(messages, limit);
  return boundary !== undefined && boundary > 0 ? boundary : undefined;
};

/**
 * The checkpoints a rewrite leaves: survivors re-based across the removed
 * span, boundaries inside the span dropped (their prompts were condensed),
 * boundaries at `start` dropped too — the prompt they open is gone. The
 * checkpoint exactly at `end` survives: its prompt starts where the tail
 * begins. `replace` changes how many messages sit before the tail.
 */
export const rebasedCheckpoints = (
  meta: HistoryMeta,
  start: number,
  end: number,
  replace?: RetainedReplacement,
): Readonly<Record<string, number>> => {
  const removed = end - start;
  // The summary and the retained messages now sit before the tail.
  const inserted = insertedCount(meta, start, end, replace);
  const checkpoints: Record<string, number> = {};
  for (const [id, boundary] of Object.entries(meta.checkpoints)) {
    if (boundary >= start && boundary < end) continue;
    checkpoints[id] =
      boundary >= end ? boundary - removed + inserted : boundary;
  }
  return checkpoints;
};

/**
 * The retained indexes a rewrite leaves: a retained message of the span moves
 * to its place after the summary, one past the span re-bases like a
 * boundary, one before it stays. The key `replace` names points at its new
 * message, after the kept ones, or is removed when it has none.
 */
export const rebasedRetained = (
  meta: HistoryMeta,
  start: number,
  end: number,
  replace?: RetainedReplacement,
): Readonly<Record<string, number>> => {
  const kept = keptBy(meta, start, end, replace);
  const removed = end - start;
  const inserted = insertedCount(meta, start, end, replace);
  const entries = Object.entries(meta.retained ?? {})
    .filter(([key]) => key !== replace?.key)
    .map(([key, index]): [string, number] => [
      key,
      index < start
        ? index
        : index < end
          ? start + 1 + kept.indexOf(index)
          : index - removed + inserted,
    ]);
  if (replace?.message !== undefined) {
    entries.push([replace.key, start + 1 + kept.length]);
  }
  return Object.fromEntries(entries);
};

/** The character count of a message the estimate reads. */
const messageChars = (message: ProviderMessage): number => {
  const content = message.content;
  if (typeof content === 'string') return content.length;
  if (content === undefined) return 0;
  return content.reduce(
    (total, part) =>
      total + (part.type === 'text' ? part.text.length : part.imageUrl.length),
    0,
  );
};

/**
 * The span's size against the summary's, as an estimated token gain. The
 * span's retained messages stay, so they free nothing and count as retained.
 * The message `replace` swaps out frees its size, and the one it swaps in
 * costs its own.
 */
export const condensation = (
  messages: readonly ProviderMessage[],
  start: number,
  end: number,
  summaryChars: number,
  meta: Pick<HistoryMeta, 'retained'> = {},
  replace?: RetainedReplacement,
): Condensation => {
  const condensed = condensedSpan(messages, meta, start, end);
  const swapped = swappedIndex(meta, start, end, replace);
  const swappedOut = swapped === undefined ? undefined : messages[swapped];
  const swappedIn = replace?.message;
  const kept =
    end -
    start -
    condensed.length -
    (swapped === undefined ? 0 : 1) +
    (swappedIn === undefined ? 0 : 1);
  const chars = [
    ...condensed,
    ...(swappedOut === undefined ? [] : [swappedOut]),
  ].reduce((total, message) => total + messageChars(message), 0);
  const added =
    summaryChars + (swappedIn === undefined ? 0 : messageChars(swappedIn));
  const freed = Math.max(0, estimatedTokens(chars) - estimatedTokens(added));
  return {
    start,
    end,
    condensedMessages: condensed.length,
    retainedMessages: messages.length - end + 1 + kept,
    summaryChars,
    tokensFreed: freed,
  };
};

/** Replay block types bound to the exact conversation that produced them. */
const boundReplay = new Set(['thinking', 'redacted_thinking']);

/** Whether one replay item is a reasoning block bound to its conversation. */
const isBoundReplay = (item: Readonly<Record<string, unknown>>): boolean => {
  const block = item.block;
  return (
    boundReplay.has(String(item.type)) ||
    (typeof block === 'object' &&
      block !== null &&
      boundReplay.has(String((block as Record<string, unknown>).type)))
  );
};

/**
 * A kept message without its bound reasoning replay. Claude signs a
 * `thinking` block against the whole conversation before it, so a block
 * kept behind a summary that replaced that conversation is refused as
 * bound to a different one (preserved thinking). Other replay items, which
 * are not bound that way, are kept.
 */
export const unbound = (message: ProviderMessage): ProviderMessage => {
  if (message.replay === undefined || !message.replay.some(isBoundReplay))
    return message;
  const { replay, ...rest } = message;
  const kept = replay.filter((item) => !isBoundReplay(item));
  return kept.length === 0 ? rest : { ...rest, replay: kept };
};

/** A history rewrite result: the next messages plus the meta that matches. */
export interface Rewritten {
  readonly messages: readonly ProviderMessage[];
  readonly meta: HistoryMeta;
}

/**
 * The messages that take the span's place: the summary, then the span's
 * retained messages verbatim, in history order, then the message `replace`
 * swaps in. The one it swaps out is not kept.
 */
export const replacement = (
  messages: readonly ProviderMessage[],
  meta: Pick<HistoryMeta, 'retained'>,
  summaryMessage: ProviderMessage,
  start: number,
  end: number,
  replace?: RetainedReplacement,
): readonly ProviderMessage[] => [
  summaryMessage,
  ...keptBy(meta, start, end, replace).map(
    (index) => messages[index] as ProviderMessage,
  ),
  ...(replace?.message === undefined ? [] : [replace.message]),
];

/**
 * The rewritten history: the summary and the span's retained messages in the
 * span's place, the tail in its order without its bound reasoning replay
 * (`unbound`), checkpoints and retained indexes re-based. The caller passes the summary already built (marker line
 * included), so this stays a pure shape transform.
 */
export const rewritten = (
  messages: readonly ProviderMessage[],
  meta: HistoryMeta,
  summaryMessage: ProviderMessage,
  start: number,
  end: number,
  replace?: RetainedReplacement,
): Rewritten => {
  const inserted = replacement(
    messages,
    meta,
    summaryMessage,
    start,
    end,
    replace,
  );
  return {
    messages: [
      ...messages.slice(0, start),
      ...inserted,
      ...messages.slice(end).map(unbound),
    ],
    meta: {
      checkpoints: rebasedCheckpoints(meta, start, end, replace),
      messageCount: messages.length - (end - start) + inserted.length,
      retained: rebasedRetained(meta, start, end, replace),
    },
  };
};

/** Whether a history still holds a summary from an earlier condensation. */
export const hasCheckpoint = (messages: readonly ProviderMessage[]): boolean =>
  messages.some(isCompactionCheckpoint);
