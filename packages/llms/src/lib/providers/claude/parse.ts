import type {
  FinishReason,
  ProviderFinished,
  ProviderStreamEvent,
  ProviderToolCall,
  UsageMetadata,
} from '../../types/provider.js';
import {
  arrayField,
  asRecord,
  numberField,
  recordField,
  stringField,
} from '../../utils/json.js';
import { deltaEvent } from '../common.js';

/** What a Claude Messages stream accumulates as it emits events. */
export interface ClaudeStreamState {
  readonly text: string[];
  readonly reasoning: string[];
  readonly calls: Map<number, ProviderToolCall>;
  usage?: UsageMetadata;
  finishReason?: FinishReason;
}

/** An empty stream state, one the events below fill as the stream runs. */
export const createClaudeStreamState = (): ClaudeStreamState => ({
  text: [],
  reasoning: [],
  calls: new Map(),
});

/**
 * Anthropic usage as the shared metadata: cache writes and reads beside the
 * input and output counts, with the total their sum.
 */
export const claudeUsage = (
  usage: Record<string, unknown> | undefined,
): UsageMetadata | undefined => {
  if (usage === undefined) {
    return undefined;
  }

  const inputTokens = numberField(usage, 'input_tokens');
  const outputTokens = numberField(usage, 'output_tokens');
  const cacheWriteTokens = numberField(usage, 'cache_creation_input_tokens');
  const cachedInputTokens = numberField(usage, 'cache_read_input_tokens');
  const counted = [
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cachedInputTokens,
  ].filter((value): value is number => value !== undefined);

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(counted.length === 0
      ? {}
      : { totalTokens: counted.reduce((sum, value) => sum + value, 0) }),
  };
};

/** An Anthropic stop_reason as the shared finish reason; an unknown one stays unset. */
export const claudeFinishReason = (
  value: unknown,
): FinishReason | undefined => {
  if (
    value === 'end_turn' ||
    value === 'stop_sequence' ||
    value === 'pause_turn'
  ) {
    return 'stop';
  }

  if (value === 'max_tokens') {
    return 'length';
  }

  if (value === 'tool_use') {
    return 'tool_calls';
  }

  if (value === 'refusal') {
    return 'content_filter';
  }

  return undefined;
};

/**
 * A finished Messages response as the shared finish: text blocks as the text,
 * thinking blocks as the reasoning, `tool_use` blocks as tool calls, and the
 * stop_reason and usage the response carries.
 */
export const parseClaudeFinished = (
  response: Record<string, unknown>,
): ProviderFinished => {
  const text: string[] = [];
  const thinking: string[] = [];
  const calls: ProviderToolCall[] = [];
  let toolIndex = 0;

  for (const block of arrayField(response, 'content')
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)) {
    if (stringField(block, 'type') === 'text') {
      text.push(stringField(block, 'text') ?? '');
      continue;
    }

    if (stringField(block, 'type') === 'thinking') {
      const thought = stringField(block, 'thinking');

      if (thought !== undefined) {
        thinking.push(thought);
      }

      continue;
    }

    if (stringField(block, 'type') === 'tool_use') {
      calls.push({
        id: stringField(block, 'id') ?? `toolu_${toolIndex}`,
        name: stringField(block, 'name') ?? '',
        arguments: claudeArguments(block.input),
        index: toolIndex,
      });

      toolIndex += 1;
    }
  }

  const reasoning = thinking.join('');

  return {
    text: text.join(''),
    finishReason: claudeFinishReason(response.stop_reason) ?? 'unknown',
    usage: claudeUsage(recordField(response, 'usage')),
    ...(reasoning === '' ? {} : { reasoning: { text: reasoning } }),
    toolCalls: calls,
  };
};

/**
 * One stream payload's events, which also fold into the state. A stream
 * ends with `message_stop`, so this never returns a `response.finished`;
 * the caller emits the finish from the accumulated state.
 */
export const claudeStreamEvents = (
  payload: Record<string, unknown>,
  state: ClaudeStreamState,
): readonly Exclude<
  ProviderStreamEvent,
  { readonly type: 'response.finished' }
>[] => {
  const events: Exclude<
    ProviderStreamEvent,
    { readonly type: 'response.finished' }
  >[] = [];
  const type = stringField(payload, 'type');

  if (type === 'message_start') {
    const message = recordField(payload, 'message') ?? {};
    mergeUsage(claudeUsage(recordField(message, 'usage')), state, events);

    return events;
  }

  if (type === 'content_block_start') {
    const index = numberField(payload, 'index') ?? 0;
    const block = recordField(payload, 'content_block') ?? {};

    if (stringField(block, 'type') === 'tool_use') {
      state.calls.set(index, {
        id: stringField(block, 'id') ?? `toolu_${index}`,
        name: stringField(block, 'name') ?? '',
        arguments: '',
        index,
      });
    }

    return events;
  }

  if (type === 'content_block_delta') {
    const index = numberField(payload, 'index') ?? 0;
    const delta = recordField(payload, 'delta') ?? {};

    if (stringField(delta, 'type') === 'text_delta') {
      const text = deltaEvent('text.delta', stringField(delta, 'text'));

      if (text !== undefined) {
        state.text.push(text.delta);
        events.push(text);
      }

      return events;
    }

    if (stringField(delta, 'type') === 'thinking_delta') {
      const reasoning = deltaEvent(
        'reasoning.delta',
        stringField(delta, 'thinking'),
      );

      if (reasoning !== undefined) {
        state.reasoning.push(reasoning.delta);
        events.push(reasoning);
      }

      return events;
    }

    if (stringField(delta, 'type') === 'input_json_delta') {
      const partial = stringField(delta, 'partial_json');
      const call = partial === undefined ? undefined : state.calls.get(index);

      if (call !== undefined) {
        const next = {
          ...call,
          arguments: `${call.arguments}${partial}`,
        };

        state.calls.set(index, next);

        events.push({
          type: 'tool_call.delta',
          index,
          id: next.id,
          name: next.name,
          argumentsDelta: partial,
        });
      }
    }

    return events;
  }

  if (type === 'content_block_stop') {
    const index = numberField(payload, 'index') ?? 0;
    const call = state.calls.get(index);

    if (call !== undefined) {
      const next = {
        ...call,
        // A block that never carried its JSON still names a call, and one
        // without arguments is the empty object every tool accepts.
        ...(call.arguments === '' ? { arguments: '{}' } : {}),
      };

      state.calls.set(index, next);

      events.push({ type: 'tool_call.done', call: next });
    }

    return events;
  }

  if (type === 'message_delta') {
    const delta = recordField(payload, 'delta') ?? {};
    const reason = claudeFinishReason(stringField(delta, 'stop_reason'));

    if (reason !== undefined) {
      state.finishReason = reason;
    }

    mergeUsage(claudeUsage(recordField(payload, 'usage')), state, events);

    return events;
  }

  return events;
};

/** Whether a stream payload reports an Anthropic error instead of progress. */
export const isClaudeStreamError = (
  payload: Record<string, unknown>,
): boolean =>
  payload.type === 'error' || recordField(payload, 'error') !== undefined;

/** The accumulated state as a finish: what the stream showed, in the order it showed it. */
export const claudeStreamFinish = (
  state: ClaudeStreamState,
): ProviderFinished => {
  const reasoning = state.reasoning.join('');

  return {
    text: state.text.join(''),
    finishReason: state.finishReason ?? 'unknown',
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    ...(reasoning === '' ? {} : { reasoning: { text: reasoning } }),
    toolCalls: [...state.calls.values()],
  };
};

/** A payload's usage as an event, and the state the finish reports. */
const mergeUsage = (
  usage: UsageMetadata | undefined,
  state: ClaudeStreamState,
  events: Exclude<
    ProviderStreamEvent,
    { readonly type: 'response.finished' }
  >[],
): void => {
  if (usage === undefined) {
    return;
  }

  state.usage = { ...state.usage, ...usage };

  events.push({ type: 'usage', usage });
};

/** The arguments a finished `tool_use` block carries, stringified; a missing one is `{}`. */
const claudeArguments = (input: unknown): string => {
  const json = JSON.stringify(input);

  return json === undefined ? '{}' : json;
};
