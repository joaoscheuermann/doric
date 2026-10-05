import type { ThreadEvent } from '@/domain/workspace';

import { type DelegatedInput, delegatedInput } from './delegated';
import {
  type LifecycleEvent,
  pauseReason,
  type PromptFailure,
  promptFailure,
  resumeAttempt,
  statesFailure,
} from './prompt-lifecycle';

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

/** The human's prompt, or another Thread's input, opening a job. */
export type UserTurn = TurnBase & {
  readonly type: 'user';
  /** The prompt as written; empty when another Thread wrote it. */
  readonly text: string;
  readonly accepted: boolean;
  /** Set when another Thread wrote this input rather than the human. */
  readonly delegated?: DelegatedInput;
  /**
   * Whether the agent has still to do anything about this prompt: the log has
   * accepted it and not moved past it, so a surface can show that it is waiting
   * rather than leaving the transcript silent.
   */
  readonly awaiting: boolean;
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

/** One block of the conversation, in the order the log produced it. */
export type Turn =
  | UserTurn
  | AgentTurn
  | ThinkingTurn
  | ToolTurn
  | ActivityTurn
  | LifecycleTurn
  | FailureTurn;

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
  | {
      type: 'user';
      promptId: string;
      events: ThreadEvent[];
      text: string;
      accepted: boolean;
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
    };

/** The draft a completed burst groups: a run of reasoning, or a tool call. */
type BurstDraft = Extract<Draft, { type: 'thinking' | 'tool_call' }>;

const isBurstDraft = (turn: Draft): turn is BurstDraft =>
  turn.type === 'thinking' || turn.type === 'tool_call';

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
  turns: readonly Draft[],
  status: ReadonlyMap<string, PromptStatus>,
): readonly Turn[] => {
  const last = turns.at(-1);
  const writing = last !== undefined && !status.has(last.promptId);

  const result: Turn[] = [];
  let index = 0;
  while (index < turns.length) {
    const turn = turns[index];
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
  item: ThreadEvent,
): void => {
  if (isTruncation(item)) return;
  const event = record(item.event);
  const promptId = item.promptId;
  const last = turns.at(-1);
  const open =
    last !== undefined && last.promptId === promptId ? last : undefined;

  if (event?.type === 'prompt.accepted') {
    const text = typeof event.text === 'string' ? event.text : '';
    const delegated = delegatedInput(event.source, text);
    turns.push({
      type: 'user',
      promptId,
      events: [item],
      text: delegated === undefined ? text : '',
      accepted: true,
      awaiting: false,
      ...(delegated === undefined ? {} : { delegated }),
    });
  } else if (event?.type === 'reasoning.delta') {
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
    } else {
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
    const message = record(event.error)?.message;
    const tool = findTool(turns, promptId, call?.id);
    if (tool?.type === 'tool_call') {
      tool.status = 'failed';
      tool.error = typeof message === 'string' ? message : '';
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
        agent.text = finished;
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
  } else if (event?.type === 'prompt.resumed') {
    const attempt = resumeAttempt(event.attempt);
    if (attempt !== undefined) {
      if (open?.type === 'lifecycle' && open.lifecycle.kind === 'pause') {
        const { reason, at } = open.lifecycle;
        open.lifecycle = { kind: 'resume', attempt, pause: { reason, at } };
        open.events.push(item);
        return;
      }
      turns.push({
        type: 'lifecycle',
        promptId,
        events: [item],
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
  }
};

/**
 * The job's lifecycle each of its agent turns carries, whether each pause still
 * stands, and the one turn of a job still running that is still being written.
 */
const settle = (
  turns: Draft[],
  status: ReadonlyMap<string, PromptStatus>,
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
  let newerUserPrompt = false;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.type === 'user' && turn.delegated === undefined)
      newerUserPrompt = true;
    if (turn === undefined || turn.type !== 'lifecycle') continue;
    const lifecycle = turn.lifecycle;
    if (lifecycle.kind === 'resume') {
      takenUp.add(turn.promptId);
      continue;
    }
    const standing =
      !newerUserPrompt &&
      !takenUp.has(turn.promptId) &&
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
  for (const item of events) readEvent(drafts, status, item);
  settle(drafts, status);
  return { events, drafts, status, turns: grouped(drafts, status) };
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
  for (const item of incoming) readEvent(drafts, status, item);
  settle(drafts, status);
  return {
    events: [...current.events, ...incoming],
    drafts,
    status,
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
