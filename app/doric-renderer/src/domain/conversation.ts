import { parsePrompt, type PromptComment } from './comments';
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
   * every edit that would land in one. While a prompt is being rewritten, that
   * prompt's own turn is writable too.
   */
  readonly writable: boolean;
  /**
   * Whether a resubmit would discard this turn. Every turn after the one being
   * edited, and the composer while an edit is in progress, render translucent:
   * they are the turn nodes a resubmit replaces.
   */
  readonly dimmed: boolean;
  readonly status: PromptStatus;
  /**
   * The person's words, or the sender's when another Thread wrote them. For a
   * user turn this is only the request half of what was sent; the comments the
   * prompt carried are `comments`, not prose.
   */
  readonly markdown: string;
  /** The agent's accumulated stream events, in order. */
  readonly segments: readonly PromptSegment[];
  /** Set when another Thread wrote this turn's words rather than the person. */
  readonly label?: string;
  /**
   * A person's turn: the comments its markdown carried, read back with
   * `parsePrompt`, so the editor renders the request as prose and the comments
   * as cards instead of showing the composed prompt's headings twice.
   */
  readonly comments?: readonly PromptComment[];
  /**
   * An agent turn: the comments that name this answer. A comment is made on an
   * answer but travels with the next prompt, so the next prompt's markdown is
   * what carries it. The marks are the comments of the user turn that follows
   * this one; for the last agent turn that follower is the composer, so its
   * marks are the comments not yet sent. This is how a comment on an answer
   * reaches the model: it rides the next prompt, which is what names it.
   */
  readonly marks?: readonly PromptComment[];
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
  /**
   * Whether the person opened this fold. Reasoning starts closed; a closed part
   * still exists and still carries its markdown, and whether that markdown
   * reaches the document is the editor's decision, not this module's.
   */
  readonly open: boolean;
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
  /** Whether the person opened this fold. A call starts closed. */
  readonly open: boolean;
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
  const sent =
    turn.userMarkdown.length > 0
      ? turn.userMarkdown
      : (turn.delegated?.text ?? '');
  const { comments, request } = parsePrompt(sent);
  return {
    key: `user:${turn.promptId}`,
    promptId: turn.promptId,
    role: 'user',
    draft: false,
    writable: false,
    dimmed: false,
    status: turn.status,
    markdown: request,
    segments: [],
    comments,
    ...(label === undefined ? {} : { label }),
  };
};

const agentTurnOf = (turn: PromptTurn): ConversationTurn => ({
  key: `agent:${turn.promptId}`,
  promptId: turn.promptId,
  role: 'agent',
  draft: false,
  writable: false,
  dimmed: false,
  status: turn.status,
  markdown: '',
  segments: turn.segments,
});

/**
 * The composer, which is always the last turn: it is the one block a person can
 * write in, so it is always there to hold the caret. Its status is not a state of
 * anything, and no cue is ever drawn for it. It carries the comments not yet
 * sent, which is what the last agent turn reads as its marks.
 */
export const draftTurn = (
  comments: readonly PromptComment[] = [],
  dimmed = false,
): ConversationTurn => ({
  key: DRAFT_KEY,
  promptId: '',
  role: 'user',
  draft: true,
  writable: true,
  dimmed,
  status: 'completed',
  markdown: '',
  segments: [],
  comments,
});

/**
 * What the person is doing to the surface, as one piece of state: the prompt
 * they are rewriting, the folds they opened, and the comments they wrote but
 * have not sent. `conversationTurns` renders from it and `conversationState` is
 * the only place it changes, so the surface never invents what a turn shows.
 */
export type ConversationState = {
  /** The promptId of the person's own turn being rewritten, if any. */
  readonly editing?: string;
  /** The fold keys the person opened. */
  readonly open: ReadonlySet<string>;
  /** Comments written but not yet sent. */
  readonly comments: readonly PromptComment[];
};

export const emptyConversationState: ConversationState = {
  open: new Set<string>(),
  comments: [],
};

export type ConversationInput =
  | { readonly kind: 'comment-added'; readonly comment: PromptComment }
  | {
      readonly kind: 'comment-body';
      readonly id: string;
      readonly body: string;
    }
  | { readonly kind: 'comment-removed'; readonly id: string }
  | { readonly kind: 'fold-toggled'; readonly key: string }
  | {
      readonly kind: 'edit-started';
      readonly promptId: string;
      readonly comments: readonly PromptComment[];
    }
  | { readonly kind: 'edit-cancelled' }
  | { readonly kind: 'submitted' };

/**
 * The surface's one transition. `submitted` clears the comments and ends the
 * edit — a sent prompt carries them into the log, so keeping them would send
 * them twice — but keeps the folds, because folding is about reading, not about
 * what is in flight. `edit-started` seeds the pending comments from the prompt
 * being rewritten, so rewriting it does not lose the comments it already held.
 */
export const conversationState = (
  state: ConversationState,
  input: ConversationInput,
): ConversationState => {
  switch (input.kind) {
    case 'comment-added':
      return { ...state, comments: [...state.comments, input.comment] };
    case 'comment-body':
      if (!state.comments.some((comment) => comment.id === input.id))
        return state;
      return {
        ...state,
        comments: state.comments.map((comment) =>
          comment.id === input.id ? { ...comment, body: input.body } : comment,
        ),
      };
    case 'comment-removed':
      return {
        ...state,
        comments: state.comments.filter((comment) => comment.id !== input.id),
      };
    case 'fold-toggled': {
      const open = new Set(state.open);
      if (open.has(input.key)) open.delete(input.key);
      else open.add(input.key);
      return { ...state, open };
    }
    case 'edit-started':
      return { ...state, editing: input.promptId, comments: input.comments };
    case 'edit-cancelled':
      // Cancelling drops the comments the edit seeded as well: those are the
      // prompt's own, already in the log, and keeping them editable would send
      // them a second time. What the log holds still marks the answer, because
      // that comes from the log rather than from here.
      return { open: state.open, comments: [] };
    case 'submitted':
      return { open: state.open, comments: [] };
  }
};

/**
 * The comments of the next user turn after `index`, or none when there is no
 * later user turn. For an agent turn that follower is the user turn of the next
 * prompt, or the composer for the last answer, which is how a comment travels
 * with the prompt that follows the answer it is about.
 */
const followingComments = (
  list: readonly ConversationTurn[],
  index: number,
): readonly PromptComment[] => {
  for (let position = index + 1; position < list.length; position += 1) {
    const turn = list[position];
    if (turn.role === 'user') return turn.comments ?? [];
  }
  return [];
};

/**
 * The turns a log renders, in order, with the composer last, as a function of
 * what the person is doing. A turn the log has not accepted yet is not rendered:
 * nothing durable holds its words.
 *
 * The state decides two things a turn cannot know about itself: whether it may
 * be written in (only the composer, or the prompt being rewritten) and whether a
 * resubmit would discard it (every turn after the one being edited, and the
 * composer while an edit is in progress).
 */
export const conversationTurns = (
  turns: readonly PromptTurn[],
  state: ConversationState,
): readonly ConversationTurn[] => {
  const authored = turns.flatMap((turn) =>
    turn.accepted ? [userTurnOf(turn), agentTurnOf(turn)] : [],
  );
  const editedIndex =
    state.editing === undefined
      ? -1
      : authored.findIndex((turn) => turn.key === `user:${state.editing}`);
  const settled = authored.map((turn, index) => ({
    ...turn,
    writable:
      state.editing !== undefined &&
      turn.role === 'user' &&
      turn.promptId === state.editing &&
      turn.label === undefined,
    dimmed:
      state.editing === undefined || editedIndex === -1
        ? false
        : index > editedIndex,
  }));
  const list = [
    ...settled,
    draftTurn(state.comments, state.editing !== undefined),
  ];
  return list.map((turn, index) =>
    turn.role === 'agent'
      ? { ...turn, marks: followingComments(list, index) }
      : turn,
  );
};

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

/**
 * The identity of one fold: the part a person opened or closed, inside the turn
 * that holds it. A turn keeps its key while its answer streams, so a fold the
 * person opened stays open as the reasoning it hides grows.
 */
export const foldKey = (turnKey: string, partKey: string): string =>
  `${turnKey}:${partKey}`;

const partOfSegment = (
  segment: PromptSegment,
  index: number,
  turnKey: string,
  open: ReadonlySet<string>,
): TurnPart | undefined => {
  const key = `seg:${String(index)}`;
  const folded = open.has(foldKey(turnKey, key));
  if (segment.kind === 'text') {
    return segment.text.length === 0
      ? undefined
      : { kind: 'text', key, markdown: segment.text };
  }
  if (segment.kind === 'thinking') {
    return segment.text.length === 0
      ? undefined
      : { kind: 'thinking', key, markdown: segment.text, open: folded };
  }
  return {
    kind: 'tool',
    key,
    callId: segment.callId,
    name: segment.name,
    status: segment.status,
    markdown: toolMarkdown(segment),
    open: folded,
  };
};

/**
 * What one agent turn renders, in order. The reasoning and the answer are separate
 * parts because the reasoning is a fold of its own; a tool call between two runs is
 * a part too. A person's turn has no parts: its content is simply its words.
 *
 * Folding is derived, not stored on the part: `open` names the fold keys the
 * person opened, and every reasoning or tool part is closed unless its key is
 * there. A closed part is still a part — its head has to render, and it still
 * carries its markdown — so an answer never loses content when it is folded.
 *
 * A turn the log states nothing about still yields one empty text part: every
 * turn needs a line for the caret to rest in, and a block with no children has
 * nowhere to put one.
 */
export const agentParts = (
  turn: ConversationTurn,
  open: ReadonlySet<string>,
): readonly TurnPart[] => {
  const parts = turn.segments.flatMap((segment, index) => {
    const part = partOfSegment(segment, index, turn.key, open);
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
