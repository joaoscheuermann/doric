import { shortId } from './delegated';
import { fenced } from './markdown';
import type { PromptSegment, PromptStatus, PromptTurn } from './projector';

/**
 * The conversation as the surface renders it: one entry per turn block, in the
 * log's order, with the composer last. It is derived, never stored — the durable
 * source is the Thread's event log, and `useThreadChat` is the only reader of it.
 *
 * The keys are what make the document stable: while an answer streams, the same
 * turn keeps its key and only its content grows, so the editor updates in place
 * instead of rebuilding the document under the caret.
 */
export const DRAFT_KEY = 'draft';

export type TurnRole = 'user' | 'agent';

export type ConversationTurn = {
  /** Stable identity of the block: `user:<promptId>`, `agent:<promptId>`, or `draft`. */
  readonly key: string;
  /** The prompt this turn answers or carries; empty for the composer. */
  readonly promptId: string;
  readonly role: TurnRole;
  /** The composer: the one turn a person types into. */
  readonly draft: boolean;
  /**
   * Whether the person may write in this turn. Only the composer is writable:
   * every other turn is a rendering of durable history, and the editor refuses
   * every edit that would land in one.
   */
  readonly writable: boolean;
  readonly status: PromptStatus;
  /** The person's words, or the sender's when another Thread wrote them. */
  readonly markdown: string;
  /** The agent's accumulated stream events, in order. */
  readonly segments: readonly PromptSegment[];
  /** Set when another Thread wrote this turn's words rather than the person. */
  readonly label?: string;
};

/**
 * One rendered piece of a turn. A turn's parts are the unit the editor
 * reconciles: an answer that grows rewrites the text part it is still appending
 * to, and leaves every other part — and the caret — where it is.
 */
export type TextPart = {
  readonly kind: 'text';
  readonly key: string;
  readonly markdown: string;
};

export type ThinkingPart = {
  readonly kind: 'thinking';
  readonly key: string;
  readonly markdown: string;
};

export type ToolPart = {
  readonly kind: 'tool';
  readonly key: string;
  readonly callId: string;
  readonly name: string;
  readonly status: 'running' | 'finished' | 'failed';
  /**
   * The call's payload and its outcome, already markdown: each is a fenced code
   * block, and a failure is the sentence the call reported.
   */
  readonly markdown: string;
};

export type TurnPart = TextPart | ThinkingPart | ToolPart;

/** How a turn's state reads in its mark, never how the log stores it. */
export type StatusCue = {
  readonly label: string;
  readonly tone: 'active' | 'idle' | 'failed';
};

/**
 * A delegated input says where it came from, so nobody reads another Thread's
 * words as the person's own. The sender is named by a short id: the tree of
 * names belongs to the sidebar, not to the log.
 */
const delegatedLabel = (turn: PromptTurn): string | undefined => {
  const delegated = turn.delegated;
  if (delegated === undefined) return undefined;
  const sender = `thread ${shortId(delegated.threadId)}`;
  if (delegated.kind === 'parent') return `Input from ${sender}`;
  return delegated.status === undefined
    ? `Result from ${sender}`
    : `Result from ${sender} · ${delegated.status}`;
};

const userTurnOf = (turn: PromptTurn): ConversationTurn => {
  const label = delegatedLabel(turn);
  return {
    key: `user:${turn.promptId}`,
    promptId: turn.promptId,
    role: 'user',
    draft: false,
    writable: false,
    status: turn.status,
    markdown:
      turn.userMarkdown.length > 0
        ? turn.userMarkdown
        : (turn.delegated?.text ?? ''),
    segments: [],
    ...(label === undefined ? {} : { label }),
  };
};

const agentTurnOf = (turn: PromptTurn): ConversationTurn => ({
  key: `agent:${turn.promptId}`,
  promptId: turn.promptId,
  role: 'agent',
  draft: false,
  writable: false,
  status: turn.status,
  markdown: '',
  segments: turn.segments,
});

/**
 * The composer, which is always the last turn: it is the one block a person can
 * write in, so it is always there to hold the caret. Its status is not a state of
 * anything, and no cue is ever drawn for it.
 */
export const draftTurn = (): ConversationTurn => ({
  key: DRAFT_KEY,
  promptId: '',
  role: 'user',
  draft: true,
  writable: true,
  status: 'completed',
  markdown: '',
  segments: [],
});

/**
 * The turns a log renders, in order, with the composer last. A turn the log has
 * not accepted yet is not rendered: nothing durable holds its words.
 */
export const conversationTurns = (
  turns: readonly PromptTurn[],
): readonly ConversationTurn[] => [
  ...turns.flatMap((turn) =>
    turn.accepted ? [userTurnOf(turn), agentTurnOf(turn)] : [],
  ),
  draftTurn(),
];

/**
 * What a tool call shows: its payload and its outcome, each as a code block so
 * nothing in them is read as prose, and the sentence a failed call reported as a
 * quote.
 */
const toolMarkdown = (
  segment: Extract<PromptSegment, { kind: 'tool' }>,
): string => {
  const blocks = [
    fenced(segment.args.length === 0 ? '{}' : segment.args, 'json'),
  ];
  if (segment.result !== undefined && segment.result.length > 0) {
    blocks.push(fenced(segment.result));
  }
  if (segment.error !== undefined && segment.error.length > 0) {
    blocks.push(`> ${segment.error}`);
  }
  return blocks.join('\n\n');
};

const partOfSegment = (
  segment: PromptSegment,
  index: number,
): TurnPart | undefined => {
  const key = `seg:${String(index)}`;
  if (segment.kind === 'text') {
    return segment.text.length === 0
      ? undefined
      : { kind: 'text', key, markdown: segment.text };
  }
  if (segment.kind === 'thinking') {
    return segment.text.length === 0
      ? undefined
      : { kind: 'thinking', key, markdown: segment.text };
  }
  return {
    kind: 'tool',
    key,
    callId: segment.callId,
    name: segment.name,
    status: segment.status,
    markdown: toolMarkdown(segment),
  };
};

/**
 * What one agent turn renders, in order. The reasoning and the answer are separate
 * parts because the reasoning is a fold of its own; a tool call between two runs is
 * a part too. A person's turn has no parts: its content is simply its words.
 *
 * A turn the log states nothing about still yields one empty text part: every
 * turn needs a line for the caret to rest in, and a block with no children has
 * nowhere to put one.
 */
export const agentParts = (turn: ConversationTurn): readonly TurnPart[] => {
  const parts = turn.segments.flatMap((segment, index) => {
    const part = partOfSegment(segment, index);
    return part === undefined ? [] : [part];
  });
  return parts.length === 0
    ? [{ kind: 'text', key: 'empty', markdown: '' }]
    : parts;
};

/**
 * Everything a part's rendered blocks depend on. Two parts with the same
 * signature render the same blocks, which is what lets the editor leave a part
 * alone while the rest of the answer grows.
 */
export const partSignature = (part: TurnPart): string =>
  part.kind === 'tool'
    ? `tool:${part.callId}:${part.name}:${part.status}:${part.markdown}`
    : `${part.kind}:${part.markdown}`;

/**
 * The shape of the document: which blocks it holds, in which order. The editor
 * compares it with what it actually holds, so a mutation that slipped past the
 * refusals is repaired rather than left on screen.
 */
export const documentSignature = (turns: readonly ConversationTurn[]): string =>
  turns
    .map((turn) => `${turn.role}:${turn.key}:${turn.draft ? 'draft' : 'log'}`)
    .join('\u0000');

/**
 * How a turn's state reads beside its avatar. Only an agent turn has a state to
 * report — a person's own prompt is not "queued", it is simply there — and a
 * finished turn says nothing.
 */
export const statusCue = (
  role: TurnRole,
  status: PromptStatus,
): StatusCue | undefined => {
  if (role !== 'agent') return undefined;
  switch (status) {
    case 'queued':
      return { label: 'Queued', tone: 'idle' };
    case 'streaming':
      return { label: 'Working', tone: 'active' };
    case 'failed':
      return { label: 'Failed', tone: 'failed' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'idle' };
    default:
      return undefined;
  }
};
