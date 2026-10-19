import { randomUUID } from 'node:crypto';

import type { ProviderMessage } from 'llms';

import { isSafeBoundary } from './boundaries.js';
import { CompactionError } from './errors.js';
import {
  type CompactionCheckpoint,
  checkpointMessage,
  isCompactionCheckpoint,
} from './markers.js';
import type { HistoryMeta } from './rewrite.js';
import {
  type Condensation,
  condensation,
  condensibleEnd,
  type Rewritten,
  rewritten,
} from './rewrite.js';

/*
 * The compaction steps a trigger drives (the contract's compactIfNeeded and
 * compactNow, one implementation). The steps stay session-agnostic: the
 * caller records `compaction.started` before `summarize` yields anything,
 * revalidates the planned cut, and records the rewrite's result — the module
 * only decides, summarizes and reshapes, never writes.
 */

/** The automatic and manual policy knobs the executor reads from config. */
export interface CompactionPolicy {
  readonly tailMinMessages: number;
  readonly summaryMaxChars: number;
}

/** What planning answers before the bracket opens. */
export type CompactionPlan =
  | {
      readonly status: 'planned';
      /** The safe cut the span [0, end) condenses up to. */
      readonly end: number;
    }
  | {
      readonly status: 'refused';
      readonly reason: 'missing_history' | 'nothing_to_compact';
    };

/**
 * The cut a condensation would use: the largest safe boundary that keeps at
 * least `tailMin` messages behind it. `missing_history` when there is no
 * history yet; `nothing_to_compact` when no safe cut fits — the tail the
 * policy protects is the whole conversation, or the span would be empty.
 */
export const planCompaction = (
  messages: readonly ProviderMessage[],
  policy: CompactionPolicy,
): CompactionPlan => {
  if (messages.length === 0)
    return { status: 'refused', reason: 'missing_history' };
  const end = condensibleEnd(messages, policy.tailMinMessages);
  return end === undefined ||
    messages.slice(0, end).every(isCompactionCheckpoint)
    ? { status: 'refused', reason: 'nothing_to_compact' }
    : { status: 'planned', end };
};

/** The planned rewrite's inputs, once the summary exists. */
export interface ApplyInput {
  readonly messages: readonly ProviderMessage[];
  readonly meta: HistoryMeta;
  readonly end: number;
  readonly trigger: CompactionCheckpoint['trigger'];
  readonly summaryId: string;
  /** The summarizer's body, without the marker line. */
  readonly summary: string;
}

/** What one applied condensation produced: the rewrite and its accounting. */
export interface Applied {
  readonly summaryId: string;
  readonly summaryMessage: ProviderMessage;
  readonly rewritten: Rewritten;
  readonly condensation: Condensation;
}

/**
 * Applies one condensation: revalidates the planned cut against the current
 * history (the span the caller selected can have moved — the manual path
 * revalidates rather than trusting a stale plan), shapes the summary
 * message, and returns the rewrite. Throws `unsafe_boundary` when the cut
 * would now split a tool pair, which the caller records and reports.
 */
export const applyCompaction = (input: ApplyInput): Applied => {
  const { messages, meta, end, trigger, summaryId, summary } = input;
  if (!isSafeBoundary(messages, end)) {
    throw new CompactionError(
      'unsafe_boundary',
      'The planned compaction boundary no longer balances tool calls.',
    );
  }
  const checkpoint: CompactionCheckpoint = { start: 0, end, trigger };
  const content = checkpointMessage(summary, checkpoint);
  const summaryMessage: ProviderMessage = { role: 'user', content };
  return {
    summaryId,
    summaryMessage,
    rewritten: rewritten(messages, meta, summaryMessage, 0, end),
    condensation: condensation(messages, 0, end, content.length),
  };
};

/** A fresh summary id, stable in the log and the rewrite. */
export const newSummaryId = (): string => `compaction-${randomUUID()}`;
