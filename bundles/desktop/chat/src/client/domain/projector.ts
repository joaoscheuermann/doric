import {
  COMMENTS_ADDED_EVENT,
  COMMENTS_RESOLVED_EVENT,
  type TurnComment,
  turnCommentFrom,
} from '../../contracts/index.js';
import {
  askedIn,
  COMMENT_REPLY_TOOL,
  type CommentThread,
  type CommentThreads,
  foldComment,
  foldResolved,
  isAgentComment,
  resolvedFrom,
  type ThreadComment,
} from './comment-threads.js';
import type { DelegatedInput } from './delegated.js';
import { failureText } from './errors.js';
import { type PromptExecution, readExecution } from './projector-execution.js';
import { type PromptInput, readInput } from './projector-input.js';
import {
  type LifecycleEvent,
  type PromptFailure,
  pauseReason,
  promptFailure,
  statesFailure,
} from './prompt-lifecycle.js';
import type { QueueItem } from './queue.js';
import type { TerminalResult } from './terminal-result.js';
import type { ThreadEvent } from './workspace.js';

export type PromptStatus =
  | 'queued'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ToolStatus = 'running' | 'finished' | 'failed';

/** What every turn shares: the prompt job it belongs to, and its own events. */
type TurnBase = {
  /**
   * The prompt job this turn belongs to. One job emits several turns, and a
   * rewind names a prompt, so the id is what ties them back together.
   */
  readonly promptId: string;
  /** The events this turn was projected from, in log order. */
  readonly events: readonly ThreadEvent[];
};

/**
 * The human's prompt, another Thread's input or a background terminal's answer,
 * opening a job.
 */
export type UserTurn = TurnBase & {
  readonly type: 'user';
  /**
   * The prompt as written; empty when another Thread or a background terminal
   * wrote it, since the block reads the input's own fields instead.
   */
  readonly text: string;
  readonly accepted: boolean;
  /**
   * The comments the send flushed with this prompt, in the order the log wrote
   * them (`comments.added/v1`): the same lines the stack drew above the
   * prompt, now durable above the words the reader sent.
   */
  readonly comments: readonly TurnComment[];
  /** Set when another Thread wrote this input rather than the human. */
  readonly delegated?: DelegatedInput;
  /**
   * Set when a background terminal wrote this input: the settled command, read
   * from the prompt the host enqueued, which the transcript draws as its own
   * block instead of the Markdown the host framed it in.
   */
  readonly terminal?: TerminalResult;
  /**
   * Whether the agent has still to do anything about this prompt: the log has
   * accepted it and not moved past it, so a surface can show that it is waiting
   * rather than leaving the transcript silent.
   */
  readonly awaiting: boolean;
};

/** A durable receipt at submission time, separate from the execution's prompt. */
export type QueuedTurn = TurnBase & {
  readonly type: 'queued';
  readonly items: readonly {
    readonly promptId: string;
    readonly text: string;
    readonly source: QueueItem['source'];
  }[];
};

/** A run of the agent's user-visible text: one answer, streaming and settled. */
export type AgentTurn = TurnBase & {
  readonly type: 'agent';
  /** The run's text: its deltas, then the finished text when it is the last. */
  readonly text: string;
  /** The job's lifecycle, so a surface can show progress, failure, cancellation. */
  readonly status: PromptStatus;
};

/** A run of the agent's reasoning, kept apart from the text it produced. */
export type ThinkingTurn = TurnBase & {
  readonly type: 'thinking';
  readonly text: string;
  /**
   * Whether the log is still writing this run. Reasoning carries no lifecycle of
   * its own, so it is derived: only the transcript's last turn can still be
   * written, and only while its job has not settled.
   */
  readonly streaming: boolean;
};

/** One tool call, from `tool.started` to its `tool.finished`/`tool.failed`. */
export type ToolTurn = TurnBase & {
  readonly type: 'tool_call';
  readonly callId: string;
  readonly name: string;
  /** One-line JSON of the call payload, ready for a truncated preview. */
  readonly args: string;
  readonly status: ToolStatus;
  /** Serialized `record.output` from the finished call. */
  readonly result?: string;
  readonly error?: string;
};

/** One grouped step of a completed burst: a run of reasoning, or a tool call. */
export type ActivityItem =
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly name: string;
      readonly args: string;
      readonly status: ToolStatus;
      readonly result?: string;
      readonly error?: string;
    };

/**
 * A completed burst of the agent's reasoning and tool calls, kept as one block so
 * a transcript is not a list of every step it took. Only a burst that did more
 * than one thing is grouped: a lone step of reasoning or a lone tool call reads
 * as itself, and so does the burst still being written.
 */
export type ActivityTurn = TurnBase & {
  readonly type: 'activity';
  /** How many reasoning runs and tool calls the burst grouped. */
  readonly thoughts: number;
  readonly tools: number;
  readonly items: readonly ActivityItem[];
};

/**
 * A pause that left a prompt unfinished, or the resume that took it up again: a
 * quiet row between the blocks it sits between, with the option to take the
 * prompt up again when the pause still stands.
 */
export type LifecycleTurn = TurnBase & {
  readonly type: 'lifecycle';
  readonly lifecycle: LifecycleEvent;
};

/** A prompt the host closed as a failure, and what it was closed with. */
export type FailureTurn = TurnBase & {
  readonly type: 'failure';
  readonly failure: PromptFailure;
};

/**
 * One compaction of the thread's history, from the bracket its events span: the
 * run that condensed older turns into a summary, or the attempt that failed to.
 * The bracket belongs to one prompt, so the row stands where that prompt's log
 * holds it.
 */
export type CompactionTurn = TurnBase & {
  readonly summaryId?: string;
  readonly summary?: string;
  readonly type: 'compaction';
  /** What asked for the compaction: the job's own budget, or the reader. */
  readonly trigger: 'automatic' | 'manual';
  readonly status: 'open' | 'completed' | 'failed';
  /** How many messages the summary condensed, once the bracket has closed. */
  readonly condensedMessages?: number;
  /** How many tokens condensing the history gave back, once it has closed. */
  readonly tokensFreed?: number;
  /** Why a failed compaction failed, as the log named it. */
  readonly code?: 'summarizer_failed' | 'unsafe_boundary';
};

/** One answer the agent wrote into a comment's thread (`comment_reply`). */
export type CommentReply = {
  /** The agent's reply, as `comments.added/v1` carried it. */
  readonly reply: TurnComment;
  /** The thread's root comment id. */
  readonly rootId: string;
  /**
   * The comment it answers: the latest one the reader wrote in the thread
   * before the reply — the root, or the reader's own reply after it.
   */
  readonly asked?: ThreadComment;
};

/**
 * The agent's answers to the reader's comments, where it wrote them in its
 * turn: consecutive replies (with only their own `comment_reply` calls
 * between them) are one block.
 */
export type RepliesTurn = TurnBase & {
  readonly type: 'replies';
  readonly replies: readonly CommentReply[];
};

/** One block of the conversation, in the order the log produced it. */
export type Turn =
  | UserTurn
  | QueuedTurn
  | AgentTurn
  | ThinkingTurn
  | ToolTurn
  | ActivityTurn
  | LifecycleTurn
  | CompactionTurn
  | FailureTurn
  | RepliesTurn;

export type Projection = {
  /** Every event the log holds, in durable order, deduplicated. */
  readonly events: readonly ThreadEvent[];
  /** The turns a surface renders. */
  readonly turns: readonly Turn[];
  /**
   * The turns as they are still being built, and the job's lifecycle per prompt:
   * the reading's own state. A surface reads `turns`; these are kept so a batch
   * that follows the log reads itself instead of the whole log behind it, and a
   * turn it changes is a copy, so a projection is never altered after it was
   * returned.
   */
  readonly drafts: readonly Draft[];
  readonly status: ReadonlyMap<string, PromptStatus>;
  readonly executions: ReadonlyMap<string, PromptExecution>;
  readonly inputs: ReadonlyMap<string, PromptInput>;
  /**
   * The comments each prompt's log holds (`comments.added/v1`), kept per prompt
   * until the prompt's user turn appears: the flush writes them just below the
   * reader's words, and the turn wears them above those words.
   */
  readonly comments: ReadonlyMap<string, readonly TurnComment[]>;
  /**
   * Every comment thread of the log by root id — `comments.added/v1` and
   * `comments.resolved/v1` folded across the whole Thread — so a surface reads
   * the state each comment is in now, wherever the comment was drawn.
   */
  readonly threads: CommentThreads;
};

const terminalStatus = (status: string): PromptStatus => {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'completed';
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const oneLineJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

/** A turn while it is still being built; frozen into a `Turn` at the end. */
export type Draft =
  | QueuedTurn
  | {
      type: 'user';
      promptId: string;
      events: ThreadEvent[];
      text: string;
      accepted: boolean;
      comments: TurnComment[];
      delegated?: DelegatedInput;
      awaiting: boolean;
    }
  | {
      type: 'agent';
      promptId: string;
      events: ThreadEvent[];
      text: string;
      status: PromptStatus;
    }
  | {
      type: 'thinking';
      promptId: string;
      events: ThreadEvent[];
      text: string;
      streaming: boolean;
    }
  | {
      type: 'tool_call';
      promptId: string;
      events: ThreadEvent[];
      callId: string;
      name: string;
      args: string;
      status: ToolStatus;
      result?: string;
      error?: string;
    }
  | {
      type: 'lifecycle';
      promptId: string;
      events: ThreadEvent[];
      lifecycle: LifecycleEvent;
    }
  | {
      type: 'failure';
      promptId: string;
      events: ThreadEvent[];
      failure: PromptFailure;
    }
  | {
      type: 'replies';
      promptId: string;
      events: ThreadEvent[];
      replies: readonly CommentReply[];
    }
  | {
      type: 'compaction';
      promptId: string;
      events: ThreadEvent[];
      trigger: 'automatic' | 'manual';
      /**
       * `open` shows progress until the bracket's closing event arrives.
       */
      status: 'open' | 'completed' | 'failed';
      summaryId?: string;
      summary?: string;
      condensedMessages?: number;
      tokensFreed?: number;
      code?: 'summarizer_failed' | 'unsafe_boundary';
    };

/** The draft a completed burst groups: a run of reasoning, or a tool call. */
type BurstDraft = Extract<Draft, { type: 'thinking' | 'tool_call' }>;

/** The draft of a block of the agent's comment replies. */
type RepliesDraft = Extract<Draft, { type: 'replies' }>;

/**
 * Whether a draft is a `comment_reply` call its reply block stands in for: one
 * that has not failed. A failed call keeps its row, which states the error.
 */
const isReplyCall = (turn: Draft): boolean =>
  turn.type === 'tool_call' &&
  turn.name === COMMENT_REPLY_TOOL &&
  turn.status !== 'failed';

/**
 * The reply block a new reply joins: the prompt's last one, while nothing but
 * the `comment_reply` calls it stands in for was written after it.
 */
const openReplies = (
  turns: readonly Draft[],
  promptId: string,
): RepliesDraft | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined || turn.promptId !== promptId) return undefined;
    if (turn.type === 'replies') return turn;
    if (!isReplyCall(turn)) return undefined;
  }
  return undefined;
};

/** The draft a compaction bracket holds while the log has not closed it. */
type CompactionDraft = Extract<Draft, { type: 'compaction' }>;

/**
 * Whether a draft belongs to the burst an `ActivityTurn` folds together:
 * reasoning and tool calls other than `edit` and `write`, which stay out of the
 * summary as their own turn blocks so every file modification remains visible in
 * the flow.
 */
const isBurstDraft = (turn: Draft): turn is BurstDraft =>
  turn.type === 'thinking' ||
  (turn.type === 'tool_call' && turn.name !== 'edit' && turn.name !== 'write');

/** One grouped step, in the shape a surface renders it. */
const activityItem = (item: BurstDraft): ActivityItem =>
  item.type === 'thinking'
    ? { kind: 'thinking', text: item.text }
    : {
        kind: 'tool',
        name: item.name,
        args: item.args,
        status: item.status,
        ...(item.result === undefined ? {} : { result: item.result }),
        ...(item.error === undefined ? {} : { error: item.error }),
      };

/** A burst, frozen into the one block that stands in for it. */
const activity = (run: readonly BurstDraft[]): ActivityTurn => ({
  type: 'activity',
  promptId: run[0]?.promptId ?? '',
  events: run.flatMap((item) => item.events),
  thoughts: run.filter((item) => item.type === 'thinking').length,
  tools: run.filter((item) => item.type === 'tool_call').length,
  items: run.map(activityItem),
});

/**
 * The turns a surface renders: every burst of reasoning and tool calls that is
 * done and did more than one thing becomes one turn, while the steps of a burst
 * of one, and of the burst the log is still writing — the transcript's last, in
 * a job that has not settled — stay on their own, so a lone step reads as itself
 * and the reader watches the live burst as it happens.
 */
const grouped = (
  drafts: readonly Draft[],
  status: ReadonlyMap<string, PromptStatus>,
): readonly Turn[] => {
  // A `comment_reply` call draws no row of its own: its reply block says what
  // it wrote, where it wrote it.
  const turns = drafts.filter((turn) => !isReplyCall(turn));
  const last = turns.at(-1);
  const writing = last !== undefined && !status.has(last.promptId);

  const result: Turn[] = [];
  let index = 0;
  while (index < turns.length) {
    const turn = turns[index];
    if (turn?.type === 'queued') {
      const items = [...turn.items];
      const events = [...turn.events];
      let end = index + 1;
      while (end < turns.length) {
        const next = turns[end];
        if (next?.type !== 'queued') break;
        items.push(...next.items);
        events.push(...next.events);
        end += 1;
      }
      result.push({ ...turn, items, events });
      index = end;
      continue;
    }
    if (turn === undefined || !isBurstDraft(turn)) {
      if (turn !== undefined) result.push(turn);
      index += 1;
      continue;
    }

    let end = index;
    while (end + 1 < turns.length) {
      const next = turns[end + 1];
      if (
        next === undefined ||
        !isBurstDraft(next) ||
        next.promptId !== turn.promptId
      )
        break;
      end += 1;
    }

    const run = turns.slice(index, end + 1).filter(isBurstDraft);
    // A burst of one step has nothing to summarize: the step is the whole of it,
    // and a summary would only repeat it.
    if (run.length === 1 || (writing && end === turns.length - 1))
      result.push(...run);
    else result.push(activity(run));
    index = end + 1;
  }

  return result;
};

/**
 * The compaction bracket a `compaction.finished`/`compaction.failed` closes, by
 * prompt: the bracket the log opened and has not closed yet, wherever the work
 * the run went on with sits between the two halves.
 */
const findOpenCompaction = (
  turns: readonly Draft[],
  promptId: string,
): CompactionDraft | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      turn?.type === 'compaction' &&
      turn.promptId === promptId &&
      turn.status === 'open'
    )
      return turn;
  }
  return undefined;
};

/** The tool turn a `tool.finished`/`tool.failed` belongs to, by call id. */
const findTool = (
  turns: readonly Draft[],
  promptId: string,
  callId: unknown,
): Draft | undefined => {
  if (typeof callId !== 'string') return undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      turn?.type === 'tool_call' &&
      turn.promptId === promptId &&
      turn.callId === callId
    ) {
      return turn;
    }
  }
  return undefined;
};

/** The last agent turn of a job, which the finished text replaces. */
const lastAgent = (
  turns: readonly Draft[],
  promptId: string,
): Draft | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.type === 'lifecycle' && turn.promptId === promptId)
      return undefined;
    if (turn?.type === 'agent' && turn.promptId === promptId) return turn;
  }
  return undefined;
};

/** A queue receipt splits a streamed answer without making its prefix new text. */
const finishedTail = (
  turns: readonly Draft[],
  agent: Draft,
  text: string,
): string => {
  let prefix = '';
  for (let index = turns.indexOf(agent) - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.type === 'queued') continue;
    if (turn?.type !== 'agent' || turn.promptId !== agent.promptId) break;
    prefix = turn.text + prefix;
  }
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
};

/** The failure block a job's `agent.failed` wrote, which states why it closed. */
const lastFailure = (
  turns: readonly Draft[],
  promptId: string,
): PromptFailure | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.type === 'failure' && turn.promptId === promptId)
      return turn.failure;
  }
  return undefined;
};

/**
 * Whether a run already states a failed job: its own `agent.failed` carries the
 * reason, so the host's generic finished text would only repeat it. A completion
 * is never explained this way, and a failure that says nothing for itself leaves
 * the finished text to state it.
 */
const statedByRun = (
  turns: readonly Draft[],
  promptId: string,
  terminal: PromptStatus,
): boolean =>
  terminal === 'failed' && lastFailure(turns, promptId) !== undefined;

/**
 * The conversation a log holds: one turn per contiguous run of events, in the
 * order the log produced them. A human prompt, an agent answer, its reasoning
 * and each tool call are their own turn, so a surface renders a transcript
 * rather than one lump per prompt.
 *
 * A delta extends the turn it continues only while that turn is still the last
 * one written, so reasoning, text and tools that interleave stay in order. The
 * job's lifecycle is one value, carried by each of its agent turns.
 */
/**
 * Reads one event of the log into the turns being built. A turn the event
 * changes is written where it sits, which is safe because the read owns its
 * turns and their events arrays: a batch that follows the log starts from
 * copies of the ones read before it, so a projection is never altered after it
 * was returned, and appending an event is a push into that copy — never a copy
 * of a growing array per event, which would make a long run cost its length
 * squared in element copying.
 */
const readEvent = (
  turns: Draft[],
  status: Map<string, PromptStatus>,
  executions: Map<string, PromptExecution>,
  inputs: Map<string, PromptInput>,
  comments: Map<string, TurnComment[]>,
  threads: Map<string, CommentThread>,
  item: ThreadEvent,
): void => {
  if (isTruncation(item)) return;
  const event = record(item.event);
  const promptId = item.promptId;
  const last = turns.at(-1);
  const open =
    last !== undefined && last.promptId === promptId ? last : undefined;
  const recovery = readExecution(executions, item, event);
  // The comments the log already wrote for this prompt are part of its user
  // turn: the turn is the reader's words, and the comments their margin.
  const input = readInput(inputs, comments, item, event);
  if (input !== undefined) {
    turns.push(input);
    return;
  }

  if (item.type === COMMENTS_RESOLVED_EVENT) {
    const resolved = resolvedFrom(event);
    if (resolved !== undefined)
      foldResolved(threads, resolved.commentId, resolved.resolved);
    return;
  }

  if (item.type === COMMENTS_ADDED_EVENT) {
    const comment = turnCommentFrom(event);
    if (comment === undefined) return;

    // The agent's answer in a comment's thread is drawn where it wrote it, in
    // its own turn: a reply block that names the comment it answers.
    if (comment.inReplyTo !== undefined && isAgentComment(comment)) {
      const thread = threads.get(comment.inReplyTo);
      const asked = thread === undefined ? undefined : askedIn(thread);
      foldComment(threads, comment);
      const reply: CommentReply = {
        reply: comment,
        rootId: comment.inReplyTo,
        ...(asked === undefined ? {} : { asked }),
      };
      const block = openReplies(turns, promptId);
      if (block === undefined) {
        turns.push({
          type: 'replies',
          promptId,
          events: [item],
          replies: [reply],
        });
      } else {
        block.replies = [...block.replies, reply];
        block.events.push(item);
      }
      return;
    }

    // The turn is shown: the comment joins it there. It is not: it waits
    // where the flush wrote it, below the words the reader is still writing.
    const turn =
      open?.type === 'user' && open.promptId === promptId ? open : undefined;
    const held = comments.get(promptId) ?? [];
    const pin = (turn === undefined ? held.length : turn.comments.length) + 1;
    foldComment(threads, { ...comment, pin });
    if (turn === undefined) {
      comments.set(promptId, [...held, comment]);
      return;
    }
    turn.comments = [...turn.comments, comment];
    turn.events.push(item);
    return;
  }

  if (event?.type === 'reasoning.delta') {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    // A delta that carries no text says nothing changed, so it neither opens a
    // turn nor ends the run it sits inside. A provider that emits one beside
    // each reasoning token would otherwise split the run into a step per token.
    if (delta.length === 0) return;
    if (open?.type === 'thinking') {
      open.text += delta;
      open.events.push(item);
    } else {
      turns.push({
        type: 'thinking',
        promptId,
        events: [item],
        text: delta,
        streaming: false,
      });
    }
  } else if (event?.type === 'text.delta') {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    // Same rule as reasoning: an empty delta is not an answer starting.
    if (delta.length === 0) return;
    if (open?.type === 'agent') {
      open.text += delta;
      open.events.push(item);
    } else if (delta.trim().length > 0) {
      // Blank lines alone are not an answer either: some models emit a lone
      // "\n\n" between their reasoning and a tool call, which would draw an
      // empty block and split the run. Inside an answer they still count.
      turns.push({
        type: 'agent',
        promptId,
        events: [item],
        text: delta,
        status: 'streaming',
      });
    }
  } else if (event?.type === 'tool.started') {
    const call = record(event.call);
    turns.push({
      type: 'tool_call',
      promptId,
      events: [item],
      callId: typeof call?.id === 'string' ? call.id : '',
      name: typeof call?.name === 'string' ? call.name : '',
      args: oneLineJson(call?.payload),
      status: 'running',
    });
  } else if (event?.type === 'tool.finished') {
    const call = record(event.call);
    const output = record(event.record)?.output;
    const tool = findTool(turns, promptId, call?.id);
    if (tool?.type === 'tool_call') {
      tool.status = 'finished';
      tool.result = typeof output === 'string' ? output : '';
      tool.events.push(item);
    }
  } else if (event?.type === 'tool.failed') {
    const call = record(event.call);
    const tool = findTool(turns, promptId, call?.id);
    if (tool?.type === 'tool_call') {
      tool.status = 'failed';
      tool.error = failureText(event.error);
      tool.events.push(item);
    }
  } else if (event?.type === 'prompt.finished') {
    const terminal = terminalStatus(
      typeof event.status === 'string' ? event.status : 'completed',
    );
    const finished = typeof event.text === 'string' ? event.text : '';
    const agent = lastAgent(turns, promptId);
    // A finished run is authoritative; a failed one keeps whatever streamed,
    // unless it streamed nothing and the host still named a result.
    if (terminal === 'completed' || agent === undefined) {
      if (agent?.type === 'agent') {
        agent.text = finishedTail(turns, agent, finished);
        agent.events.push(item);
      } else if (
        finished.length > 0 &&
        !statedByRun(turns, promptId, terminal)
      ) {
        turns.push({
          type: 'agent',
          promptId,
          events: [item],
          text: finished,
          status: terminal,
        });
      }
    }
    status.set(promptId, terminal);
  } else if (event?.type === 'prompt.paused') {
    const reason = pauseReason(event.reason);
    if (reason !== undefined) {
      turns.push({
        type: 'lifecycle',
        promptId,
        events: [item],
        // Whether the pause still stands is settled once the whole log is read:
        // a resume or a completion later in it is what takes it away.
        lifecycle: {
          kind: 'pause',
          reason,
          at: item.createdAt,
          standing: true,
        },
      });
    }
  } else if (event?.type === 'agent.started') {
    if (recovery !== undefined) {
      const { attempt, event: recovered } = recovery;
      if (open?.type === 'lifecycle' && open.lifecycle.kind === 'pause') {
        const { reason, at } = open.lifecycle;
        open.lifecycle = { kind: 'resume', attempt, pause: { reason, at } };
        open.events.push(recovered, item);
        return;
      }
      turns.push({
        type: 'lifecycle',
        promptId,
        events: [recovered, item],
        lifecycle: { kind: 'resume', attempt },
      });
    }
  } else if (event?.type === 'agent.failed') {
    // The run's own failure event states why it was closed, so it is the block a
    // surface renders rather than the host's generic failed text below. A failure
    // that says nothing for itself leaves the finished text to state it.
    const failure = promptFailure(event.error);
    if (statesFailure(failure))
      turns.push({ type: 'failure', promptId, events: [item], failure });
    status.set(promptId, 'failed');
  } else if (event?.type === 'agent.cancelled') {
    status.set(promptId, 'cancelled');
  } else if (event?.type === 'compaction.started') {
    // Show progress immediately; the closing event updates this same row.
    turns.push({
      type: 'compaction',
      promptId,
      events: [item],
      trigger: event.trigger === 'manual' ? 'manual' : 'automatic',
      status: 'open',
    });
  } else if (event?.type === 'compaction.finished') {
    // The closing half completes the bracket it belongs to, wherever the work
    // the run went on with sits between the two halves. A closing half without
    // the started one names no bracket, so it reads as nothing.
    const opened = findOpenCompaction(turns, promptId);
    if (opened !== undefined) {
      opened.status = 'completed';
      opened.summaryId =
        typeof event.summaryId === 'string' ? event.summaryId : undefined;
      opened.summary =
        typeof event.summary === 'string' ? event.summary : undefined;
      opened.condensedMessages =
        typeof event.condensedMessages === 'number'
          ? event.condensedMessages
          : undefined;
      opened.tokensFreed =
        typeof event.tokensFreed === 'number' ? event.tokensFreed : undefined;
      opened.events.push(item);
    }
  } else if (event?.type === 'compaction.failed') {
    const opened = findOpenCompaction(turns, promptId);
    if (opened !== undefined) {
      opened.status = 'failed';
      opened.code =
        event.code === 'unsafe_boundary'
          ? 'unsafe_boundary'
          : 'summarizer_failed';
      opened.events.push(item);
    }
  }
};

/**
 * The job's lifecycle each of its agent turns carries, whether each pause still
 * stands, and the one turn of a job still running that is still being written.
 */
const settle = (
  turns: Draft[],
  status: ReadonlyMap<string, PromptStatus>,
  executions: ReadonlyMap<string, PromptExecution>,
  inputs: ReadonlyMap<string, PromptInput>,
): void => {
  for (const turn of turns) {
    if (turn.type !== 'agent') continue;
    const settled = status.get(turn.promptId);
    if (settled !== undefined && turn.status !== settled) turn.status = settled;
  }

  // A pause stands until the prompt is taken up again or finished: a later resume
  // of the same prompt, or a terminal status, is what takes the reader's action
  // away. Read backwards so each pause learns whether anything after it did.
  const takenUp = new Set<string>();
  const latestHumanInput = [...inputs.values()].reduce(
    (latest, input) =>
      input.source.kind === 'user' && !input.queued
        ? Math.max(latest, input.accepted.sequence)
        : latest,
    0,
  );
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined || turn.type !== 'lifecycle') continue;
    const lifecycle = turn.lifecycle;
    if (lifecycle.kind === 'resume') {
      takenUp.add(turn.promptId);
      continue;
    }
    const standing =
      latestHumanInput <= (turn.events[0]?.sequence ?? 0) &&
      !takenUp.has(turn.promptId) &&
      (executions.get(turn.promptId)?.recoveredThrough ?? -1) <
        (turn.events[0]?.sequence ?? 0) &&
      !status.has(turn.promptId);
    if (lifecycle.standing !== standing)
      // A new event object, never a write into the one a returned projection
      // already holds: the two readings share the turn they did not change.
      turn.lifecycle = {
        at: lifecycle.at,
        kind: 'pause',
        reason: lifecycle.reason,
        standing,
      };
  }

  // The transcript's last turn is the one the log is still at. A prompt there,
  // in a job that has not settled, is a prompt the agent has not answered yet;
  // reasoning has no lifecycle of its own to read the same fact from. That last
  // burst is also the one a surface keeps whole instead of grouping.
  const last = turns.at(-1);
  const writing = last !== undefined && !status.has(last.promptId);
  for (const turn of turns) {
    const live = turn === last && writing;
    if (turn.type === 'user' && turn.awaiting !== live) turn.awaiting = live;
    else if (turn.type === 'thinking' && turn.streaming !== live)
      turn.streaming = live;
  }
};

/**
 * The conversation a log holds: one turn per contiguous run of events, in the
 * order the log produced them. A human prompt, an agent answer, its reasoning
 * and each tool call are their own turn, so a surface renders a transcript
 * rather than one lump per prompt.
 *
 * A delta extends the turn it continues only while that turn is still the last
 * one written, so reasoning, text and tools that interleave stay in order. The
 * job's lifecycle is one value, carried by each of its agent turns.
 */
const project = (events: readonly ThreadEvent[]): Projection => {
  const drafts: Draft[] = [];
  const status = new Map<string, PromptStatus>();
  const executions = new Map<string, PromptExecution>();
  const inputs = new Map<string, PromptInput>();
  const comments = new Map<string, TurnComment[]>();
  const threads = new Map<string, CommentThread>();
  for (const item of events)
    readEvent(drafts, status, executions, inputs, comments, threads, item);
  settle(drafts, status, executions, inputs);
  return {
    events,
    drafts,
    status,
    executions,
    inputs,
    comments,
    threads,
    turns: grouped(drafts, status),
  };
};

/**
 * A batch that follows the log read into the turns already read from it: the
 * turns are copied once — a copy of one is what a change writes to, so a
 * projection is never altered after it was returned — and so is each turn's
 * events array, once per batch, so the read appends to the copy instead of
 * copying the array per event. The batch then extends the tail of the reading
 * instead of the log being read again from its start.
 */
const readInto = (
  current: Projection,
  incoming: readonly ThreadEvent[],
): Projection => {
  const drafts = current.drafts.map(
    (draft): Draft => ({ ...draft, events: [...draft.events] }),
  );
  const status = new Map(current.status);
  const executions = new Map(current.executions);
  const inputs = new Map(current.inputs);
  // Only a comment event writes the comments held per prompt or the threads
  // (`readEvent`), so a batch without one reads with the maps the projection
  // already holds and returns them as they are: the threads a conversation
  // provides keep their identity across a flush of deltas, and nothing that
  // draws them is told they changed. A batch with one writes a copy — a
  // thread it changes is a new record in a copy of the map — so the
  // projection returned before keeps the threads it was read with.
  const touchesComments = incoming.some(isCommentEvent);
  const comments = touchesComments
    ? new Map(
        [...current.comments].map(
          ([promptId, held]): [string, TurnComment[]] => [promptId, [...held]],
        ),
      )
    : (current.comments as Map<string, TurnComment[]>);
  const threads = touchesComments
    ? new Map(current.threads)
    : (current.threads as Map<string, CommentThread>);
  for (const item of incoming)
    readEvent(drafts, status, executions, inputs, comments, threads, item);
  settle(drafts, status, executions, inputs);
  return {
    events: [...current.events, ...incoming],
    drafts,
    status,
    executions,
    inputs,
    comments,
    threads,
    turns: grouped(drafts, status),
  };
};

/**
 * A merge that a stream's own events need no map or sort for: the log is already
 * ordered, and the events a live run writes follow the ones held — same Thread,
 * rising sequence, no duplicate. A reconnect replays, and a rewind discards, so
 * anything that does not follow falls back to the full merge below.
 */
const followsWhatIsHeld = (
  current: readonly ThreadEvent[],
  incoming: readonly ThreadEvent[],
): boolean => {
  let last = current.at(-1)?.sequence ?? -1;
  for (const event of incoming) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= last)
      return false;
    last = event.sequence;
  }
  return true;
};

const orderedUnique = (
  current: readonly ThreadEvent[],
  incoming: readonly ThreadEvent[],
): readonly ThreadEvent[] => {
  if (followsWhatIsHeld(current, incoming)) return [...current, ...incoming];

  const byPromptAndSequence = new Map<string, ThreadEvent>();
  for (const event of [...current, ...incoming]) {
    const key = `${event.promptId}:${event.sequence}`;
    if (!byPromptAndSequence.has(key)) byPromptAndSequence.set(key, event);
  }
  return [...byPromptAndSequence.values()].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.promptId.localeCompare(right.promptId),
  );
};

/**
 * A rewind marker names the last surviving sequence and its own place in the log.
 * The discarded range sits strictly between them, so everything at or below the
 * boundary survives and the marker plus anything after it is new work.
 */
const truncation = (
  event: ThreadEvent,
):
  | { readonly afterSequence: number; readonly sequence: number }
  | undefined => {
  const payload = record(event.event);
  if (payload?.type !== 'history.truncated') return undefined;
  const afterSequence = payload.afterSequence;
  if (
    typeof afterSequence !== 'number' ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0
  ) {
    return undefined;
  }
  return { afterSequence, sequence: event.sequence };
};

/** Whether an event is the marker of a rewind, which discards the log before it. */
const isTruncation = (event: ThreadEvent): boolean =>
  record(event.event)?.type === 'history.truncated';

/** Whether an event writes a comment or its resolution: the two the threads read. */
const isCommentEvent = (event: ThreadEvent): boolean =>
  event.type === COMMENTS_ADDED_EVENT || event.type === COMMENTS_RESOLVED_EVENT;

/** Drops held events that a rewind already discarded. */
const survivors = (events: readonly ThreadEvent[]): readonly ThreadEvent[] => {
  const markers = events.flatMap((event) => truncation(event) ?? []);
  if (markers.length === 0) return events;
  return events.filter((event) =>
    markers.every(
      ({ afterSequence, sequence }) =>
        !(event.sequence > afterSequence && event.sequence < sequence),
    ),
  );
};

export const projectEvents = (
  current: Projection,
  incoming: readonly ThreadEvent[],
): Projection => {
  // A batch that follows the log extends what has been read of it. A rewind
  // discards history and a replay does not follow, so those read the log again
  // from its start.
  if (
    followsWhatIsHeld(current.events, incoming) &&
    !incoming.some(isTruncation)
  ) {
    return readInto(current, incoming);
  }
  return project(survivors(orderedUnique(current.events, incoming)));
};

export const emptyProjection: Projection = {
  events: [],
  turns: [],
  drafts: [],
  status: new Map(),
  executions: new Map(),
  inputs: new Map(),
  comments: new Map(),
  threads: new Map(),
};

/** The tool calls that can change the sandbox a Project's Threads share. */
const sandboxTools = ['write', 'edit', 'terminal', 'git'];

/**
 * How many times the log records the agent finishing a write to the sandbox.
 * The count, not the events, is what a files surface needs: it moves whenever
 * the sandbox may have changed, which is exactly when to read it again.
 */
export const sandboxWrites = (events: readonly ThreadEvent[]): number =>
  events.filter((item) => {
    const event = record(item.event);
    if (event?.type !== 'tool.finished') return false;
    const name = record(event.call)?.name;
    return typeof name === 'string' && sandboxTools.includes(name);
  }).length;
