import type { ProviderMessage } from 'llms';

import { largestSafeBoundaryAtOrBefore } from './boundaries.js';
import { isCompactionCheckpoint } from './markers.js';

/*
 * The surface rewrite (the contract's one surface mutation): the condensed
 * span [start, end) is replaced by one summary message, the retained tail
 * keeps its order, and the turn boundaries (`meta.checkpoints`) move with
 * the history — re-based across the removed span, dropped when their prompt
 * was condensed away, which is what makes a rewind to those prompts refuse
 * (`unknown_prompt`) instead of resurfacing content the summary replaced.
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
 * of the stored `messages`. Shape of `direct.history/v1`'s meta part.
 */
export interface HistoryMeta {
  readonly checkpoints: Readonly<Record<string, number>>;
  readonly messageCount: number;
}

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
 * begins.
 */
export const rebasedCheckpoints = (
  meta: HistoryMeta,
  start: number,
  end: number,
): Readonly<Record<string, number>> => {
  const removed = end - start;
  const checkpoints: Record<string, number> = {};
  for (const [id, boundary] of Object.entries(meta.checkpoints)) {
    if (boundary >= start && boundary < end) continue;
    // A surviving boundary past the span re-bases by the removed count, and
    // gains one back for the summary message that now sits before the tail.
    checkpoints[id] = boundary >= end ? boundary - removed + 1 : boundary;
  }
  return checkpoints;
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

/** The span's size against the summary's, as an estimated token gain. */
export const condensation = (
  messages: readonly ProviderMessage[],
  start: number,
  end: number,
  summaryChars: number,
): Condensation => {
  let chars = 0;
  for (let index = start; index < end; index += 1) {
    chars += messageChars(messages[index] as ProviderMessage);
  }
  const freed = Math.max(
    0,
    estimatedTokens(chars) - estimatedTokens(summaryChars),
  );
  return {
    start,
    end,
    condensedMessages: end - start,
    retainedMessages: messages.length - end + 1,
    summaryChars,
    tokensFreed: freed,
  };
};

/** A history rewrite result: the next messages plus the meta that matches. */
export interface Rewritten {
  readonly messages: readonly ProviderMessage[];
  readonly meta: HistoryMeta;
}

/**
 * The rewritten history: the summary message in the span's place, the tail
 * unchanged, checkpoints re-based. The caller passes the summary already
 * built (marker line included), so this stays a pure shape transform.
 */
export const rewritten = (
  messages: readonly ProviderMessage[],
  meta: HistoryMeta,
  summaryMessage: ProviderMessage,
  start: number,
  end: number,
): Rewritten => ({
  messages: [
    ...messages.slice(0, start),
    summaryMessage,
    ...messages.slice(end),
  ],
  meta: {
    checkpoints: rebasedCheckpoints(meta, start, end),
    messageCount: messages.length - (end - start) + 1,
  },
});

/** Whether a history still holds a summary from an earlier condensation. */
export const hasCheckpoint = (messages: readonly ProviderMessage[]): boolean =>
  messages.some(isCompactionCheckpoint);
