import type { ThreadEvent } from '@/domain/workspace';

import { type DelegatedInput, delegatedInput } from './delegated';

export type PromptStatus =
  | 'queued'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ThinkingSegment = {
  readonly kind: 'thinking';
  readonly text: string;
};

export type TextSegment = { readonly kind: 'text'; readonly text: string };

export type ToolStatus = 'running' | 'finished' | 'failed';

export type ToolSegment = {
  readonly kind: 'tool';
  readonly callId: string;
  readonly name: string;
  /** One-line JSON of the call payload, ready for a truncated preview. */
  readonly args: string;
  readonly status: ToolStatus;
  /** Serialized `record.output` from the finished call. */
  readonly result?: string;
  readonly error?: string;
};

export type PromptSegment = ThinkingSegment | TextSegment | ToolSegment;

export type PromptTurn = {
  readonly promptId: string;
  readonly sequence: number;
  readonly inputRole: 'user' | 'agent';
  readonly accepted: boolean;
  readonly userMarkdown: string;
  /** Set when another Thread wrote this turn's input rather than the human. */
  readonly delegated?: DelegatedInput;
  readonly segments: readonly PromptSegment[];
  readonly status: PromptStatus;
};

export type Projection = {
  readonly events: readonly ThreadEvent[];
  readonly turns: readonly PromptTurn[];
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

const sourceRole = (value: unknown): PromptTurn['inputRole'] =>
  record(value)?.kind === 'user' ? 'user' : 'agent';

const oneLineJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

/** Appends a delta to a trailing run of the same kind, or starts a new one. */
const appendDelta = (
  segments: readonly PromptSegment[],
  kind: 'thinking' | 'text',
  delta: string,
): readonly PromptSegment[] => {
  const last = segments.at(-1);
  if (last?.kind === kind) {
    return [...segments.slice(0, -1), { kind, text: last.text + delta }];
  }
  return [...segments, { kind, text: delta }];
};

/**
 * Replaces the last text segment, appending one when the turn has none. An
 * empty replacement never appends, so a turn that produced no text stays empty.
 */
const withLastText = (
  segments: readonly PromptSegment[],
  text: string,
): readonly PromptSegment[] => {
  let index = -1;
  for (let position = segments.length - 1; position >= 0; position -= 1) {
    if (segments[position]?.kind === 'text') {
      index = position;
      break;
    }
  }
  if (index === -1)
    return text.length === 0 ? segments : [...segments, { kind: 'text', text }];
  return segments.map((segment, position) =>
    position === index ? { kind: 'text', text } : segment,
  );
};

/** Mutates the tool segment whose `callId` matches, leaving others untouched. */
const updateTool = (
  segments: readonly PromptSegment[],
  callId: string,
  patch: Partial<ToolSegment>,
): readonly PromptSegment[] =>
  segments.map((segment) =>
    segment.kind === 'tool' && segment.callId === callId
      ? { ...segment, ...patch }
      : segment,
  );

const toolStarted = (
  segments: readonly PromptSegment[],
  call: unknown,
): readonly PromptSegment[] => {
  const value = record(call);
  if (typeof value?.id !== 'string') return segments;
  return [
    ...segments,
    {
      kind: 'tool',
      callId: value.id,
      name: typeof value.name === 'string' ? value.name : '',
      args: oneLineJson(value.payload),
      status: 'running',
    },
  ];
};

const project = (events: readonly ThreadEvent[]): readonly PromptTurn[] => {
  const turns = new Map<string, PromptTurn>();
  for (const item of events) {
    if (record(item.event)?.type === 'history.truncated') continue;
    const current = turns.get(item.promptId) ?? {
      promptId: item.promptId,
      sequence: item.sequence,
      inputRole: 'user' as const,
      accepted: false,
      userMarkdown: '',
      segments: [],
      status: 'queued' as const,
    };
    const event = record(item.event);
    if (event?.type === 'prompt.accepted') {
      const text = typeof event.text === 'string' ? event.text : '';
      const delegated = delegatedInput(event.source, text);
      turns.set(item.promptId, {
        ...current,
        inputRole: sourceRole(event.source),
        accepted: true,
        userMarkdown: delegated === undefined ? text : '',
        ...(delegated === undefined ? {} : { delegated }),
      });
    } else if (event?.type === 'reasoning.delta') {
      turns.set(item.promptId, {
        ...current,
        segments: appendDelta(
          current.segments,
          'thinking',
          typeof event.delta === 'string' ? event.delta : '',
        ),
        status: 'streaming',
      });
    } else if (event?.type === 'text.delta') {
      turns.set(item.promptId, {
        ...current,
        segments: appendDelta(
          current.segments,
          'text',
          typeof event.delta === 'string' ? event.delta : '',
        ),
        status: 'streaming',
      });
    } else if (event?.type === 'tool.started') {
      turns.set(item.promptId, {
        ...current,
        segments: toolStarted(current.segments, event.call),
        status: 'streaming',
      });
    } else if (event?.type === 'tool.finished') {
      const call = record(event.call);
      const output = record(event.record)?.output;
      turns.set(item.promptId, {
        ...current,
        segments:
          typeof call?.id === 'string'
            ? updateTool(current.segments, call.id, {
                status: 'finished',
                result: typeof output === 'string' ? output : '',
              })
            : current.segments,
        status: 'streaming',
      });
    } else if (event?.type === 'tool.failed') {
      const call = record(event.call);
      const message = record(event.error)?.message;
      turns.set(item.promptId, {
        ...current,
        segments:
          typeof call?.id === 'string'
            ? updateTool(current.segments, call.id, {
                status: 'failed',
                error: typeof message === 'string' ? message : '',
              })
            : current.segments,
        status: 'streaming',
      });
    } else if (event?.type === 'prompt.finished') {
      const status = terminalStatus(
        typeof event.status === 'string' ? event.status : 'completed',
      );
      const finishedText = typeof event.text === 'string' ? event.text : '';
      const hasText = current.segments.some(
        (segment) => segment.kind === 'text',
      );
      turns.set(item.promptId, {
        ...current,
        segments:
          status === 'completed' || !hasText
            ? withLastText(current.segments, finishedText)
            : current.segments,
        status,
      });
    } else if (event?.type === 'agent.failed') {
      turns.set(item.promptId, { ...current, status: 'failed' });
    } else if (event?.type === 'agent.cancelled') {
      turns.set(item.promptId, { ...current, status: 'cancelled' });
    } else {
      turns.set(item.promptId, current);
    }
  }
  return [...turns.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
};

const orderedUnique = (
  current: readonly ThreadEvent[],
  incoming: readonly ThreadEvent[],
): readonly ThreadEvent[] => {
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
  const events = survivors(orderedUnique(current.events, incoming));
  return { events, turns: project(events) };
};

export const emptyProjection: Projection = { events: [], turns: [] };
