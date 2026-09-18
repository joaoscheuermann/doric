import type {
  ProviderFinished,
  ProviderReplayItem,
  ProviderStreamEvent,
  ProviderToolCall,
} from '../../types/provider.js';
import {
  asRecord,
  arrayField,
  numberField,
  recordField,
  stringField,
} from '../../utils/json.js';
import { finishReason, parseUsage } from '../common.js';

export type StreamState = {
  readonly text: string[];
  readonly reasoning: string[];
  readonly refusal: string[];
  readonly calls: Map<number, ProviderToolCall>;
  readonly replay: ProviderReplayItem[];
  usage?: ProviderFinished['usage'];
  finishReason?: ProviderFinished['finishReason'];
};

export const createStreamState = (): StreamState => ({
  text: [],
  reasoning: [],
  refusal: [],
  calls: new Map(),
  replay: [],
});

export const parseFinished = (
  response: Record<string, unknown>,
): ProviderFinished => {
  const choice = asRecord(arrayField(response, 'choices')[0]) ?? {};
  const message = recordField(choice, 'message') ?? {};
  const content = stringField(message, 'content') ?? '';
  const reasoning =
    stringField(message, 'reasoning') ??
    stringField(message, 'reasoning_content');
  const refusal = stringField(message, 'refusal');
  const replay = replayItems(message);
  const toolCalls = arrayField(message, 'tool_calls')
    .map(asRecord)
    .filter(isRecord)
    .map((call, index) => {
      const fn = recordField(call, 'function') ?? {};

      return {
        id: stringField(call, 'id') ?? `call_${index}`,
        name: stringField(fn, 'name') ?? '',
        arguments: stringField(fn, 'arguments') ?? '',
        index,
      };
    });

  return {
    text: content,
    finishReason: finishReason(choice.finish_reason),
    usage: parseUsage(recordField(response, 'usage'), 'credits'),
    reasoning: reasoning === undefined ? undefined : { text: reasoning },
    refusal,
    toolCalls,
    ...(replay.length === 0 ? {} : { replay }),
  };
};

export const streamEvents = (
  payload: Record<string, unknown>,
  state: StreamState,
): readonly Exclude<
  ProviderStreamEvent,
  { readonly type: 'response.finished' }
>[] => {
  const events: Exclude<
    ProviderStreamEvent,
    { readonly type: 'response.finished' }
  >[] = [];
  const usage = parseUsage(recordField(payload, 'usage'), 'credits');

  if (usage !== undefined) {
    state.usage = usage;
    events.push({ type: 'usage', usage });
  }

  for (const choice of arrayField(payload, 'choices')
    .map(asRecord)
    .filter(isRecord)) {
    const delta = recordField(choice, 'delta') ?? {};
    const content = stringField(delta, 'content');
    const reasoning =
      stringField(delta, 'reasoning') ??
      stringField(delta, 'reasoning_content');
    const refusal = stringField(delta, 'refusal');

    state.replay.push(...replayItems(delta));

    if (content !== undefined) {
      state.text.push(content);
      events.push({ type: 'text.delta', delta: content });
    }

    if (reasoning !== undefined) {
      state.reasoning.push(reasoning);
      events.push({ type: 'reasoning.delta', delta: reasoning });
    }

    if (refusal !== undefined) {
      state.refusal.push(refusal);
      events.push({ type: 'refusal.delta', delta: refusal });
    }

    for (const call of arrayField(delta, 'tool_calls')
      .map(asRecord)
      .filter(isRecord)) {
      const index = numberField(call, 'index') ?? 0;
      const fn = recordField(call, 'function') ?? {};
      const previous = state.calls.get(index);
      const next = {
        id: stringField(call, 'id') ?? previous?.id ?? `call_${index}`,
        name: stringField(fn, 'name') ?? previous?.name ?? '',
        arguments: `${previous?.arguments ?? ''}${stringField(fn, 'arguments') ?? ''}`,
        index,
      };

      state.calls.set(index, next);
      events.push({
        type: 'tool_call.delta',
        index,
        id: next.id,
        name: next.name,
        argumentsDelta: stringField(fn, 'arguments'),
      });
    }

    state.finishReason = finishReason(choice.finish_reason);
  }

  return events;
};

export const hasProviderError = (payload: Record<string, unknown>): boolean =>
  recordField(payload, 'error') !== undefined;

export const streamToolCalls = (
  state: StreamState,
): readonly ProviderToolCall[] => [...state.calls.values()];

export const streamFinish = (state: StreamState): ProviderFinished => ({
  text: state.text.join(''),
  reasoning: { text: state.reasoning.join('') },
  refusal: state.refusal.join('') || undefined,
  finishReason: state.finishReason ?? 'unknown',
  usage: state.usage,
  toolCalls: streamToolCalls(state),
  ...(state.replay.length === 0 ? {} : { replay: state.replay }),
});

const replayItems = (
  value: Record<string, unknown>,
): readonly ProviderReplayItem[] =>
  arrayField(value, 'reasoning_details')
    .map(asRecord)
    .filter(isRecord) as readonly ProviderReplayItem[];

const isRecord = (
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> => value !== undefined;
