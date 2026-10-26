import type {
  FinishReason,
  ProviderFinished,
  ProviderReplayItem,
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
import { claudeReplayProvider } from './body.js';

/** One content block as the stream builds it, by its index in the message. */
interface StreamBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  /** Text, thinking text, or a tool call's JSON, as it accumulates. */
  content: string;
  signature: string;
  /** A `redacted_thinking` block's opaque data. */
  readonly data?: string;
  /** Whether `content_block_stop` closed it. */
  done: boolean;
}

/** What a Claude Messages stream accumulates as it emits events. */
export interface ClaudeStreamState {
  readonly blocks: Map<number, StreamBlock>;
  /** Every numeric usage count the stream reported so far, by Anthropic's name. */
  counts?: Record<string, number>;
  usage?: UsageMetadata;
  finishReason?: FinishReason;
  /** The refusal the stream ended on, as `stop_details` described it. */
  refusal?: string;
  /** Whether `message_stop` arrived: a stream without it was cut short. */
  stopped: boolean;
}

/** An empty stream state, one the events below fill as the stream runs. */
export const createClaudeStreamState = (): ClaudeStreamState => ({
  blocks: new Map(),
  stopped: false,
});

/**
 * Anthropic usage as the shared metadata. Anthropic's `input_tokens` is only
 * the uncached remainder, so the input count is that plus the cache writes
 * and reads (the whole prompt), with the cache counts kept as its parts;
 * thinking tokens are the reasoning count, and the total is input plus output.
 */
export const claudeUsage = (
  usage: Record<string, unknown> | undefined,
): UsageMetadata | undefined => {
  if (usage === undefined) {
    return undefined;
  }

  const uncached = numberField(usage, 'input_tokens');
  const outputTokens = numberField(usage, 'output_tokens');
  const cacheWriteTokens = numberField(usage, 'cache_creation_input_tokens');
  const cachedInputTokens = numberField(usage, 'cache_read_input_tokens');
  const details = recordField(usage, 'output_tokens_details');
  const reasoningTokens =
    numberField(usage, 'thinking_tokens') ??
    (details === undefined
      ? undefined
      : numberField(details, 'thinking_tokens'));
  const inputParts = [uncached, cacheWriteTokens, cachedInputTokens].filter(
    (value): value is number => value !== undefined,
  );
  const inputTokens =
    inputParts.length === 0
      ? undefined
      : inputParts.reduce((sum, value) => sum + value, 0);
  const counted = [inputTokens, outputTokens].filter(
    (value): value is number => value !== undefined,
  );

  if (counted.length === 0 && reasoningTokens === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(counted.length === 0
      ? {}
      : { totalTokens: counted.reduce((sum, value) => sum + value, 0) }),
  };
};

/**
 * An Anthropic stop_reason as the shared finish reason; an unknown one stays
 * unset. A full context window is a cut-off answer, as `max_tokens` is.
 */
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

  if (value === 'max_tokens' || value === 'model_context_window_exceeded') {
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

/** The refusal `stop_details` describes, as the line the finish reports. */
const refusalOf = (details: Record<string, unknown> | undefined): string => {
  const category =
    details === undefined ? undefined : stringField(details, 'category');
  const explanation =
    details === undefined ? undefined : stringField(details, 'explanation');
  return [
    'Claude declined to answer',
    category === undefined ? '' : ` (${category})`,
    explanation === undefined ? '.' : `: ${explanation}`,
  ].join('');
};

/** Whether a tool call's JSON is an object a tool can take. */
const parsesAsInput = (json: string): boolean => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return (
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
};

/** A replay item: one Claude content block, tagged so no other provider replays it. */
const replayItem = (block: Record<string, unknown>): ProviderReplayItem =>
  ({ provider: claudeReplayProvider, block }) as ProviderReplayItem;

/**
 * The replay a finish keeps: every content block in order, unchanged, so the
 * next request can send the turn back as it was — which a thinking block
 * needs, signature included. Only a turn that thought keeps one; a thinking
 * block that never got its signature is not one Anthropic would accept.
 */
const replayOf = (
  blocks: readonly Record<string, unknown>[],
): readonly ProviderReplayItem[] | undefined => {
  const kept = blocks.filter(
    (block) =>
      block.type !== 'thinking' ||
      (typeof block.signature === 'string' && block.signature !== ''),
  );
  return kept.some(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
  )
    ? kept.map(replayItem)
    : undefined;
};

/**
 * A finished Messages response as the shared finish: text blocks as the text,
 * thinking blocks as the reasoning, `tool_use` blocks as tool calls, the
 * blocks themselves as the replay, and the stop_reason and usage the
 * response carries. A refused answer keeps no text, calls or replay: its
 * partial output is discarded and the refusal says why.
 */
export const parseClaudeFinished = (
  response: Record<string, unknown>,
): ProviderFinished => {
  const text: string[] = [];
  const thinking: string[] = [];
  const calls: ProviderToolCall[] = [];
  const blocks = arrayField(response, 'content')
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const finishReason = claudeFinishReason(response.stop_reason) ?? 'unknown';
  const usage = claudeUsage(recordField(response, 'usage'));

  if (finishReason === 'content_filter') {
    return {
      text: '',
      finishReason,
      ...(usage === undefined ? {} : { usage }),
      refusal: refusalOf(recordField(response, 'stop_details')),
      toolCalls: [],
    };
  }

  for (const block of blocks) {
    const type = stringField(block, 'type');

    if (type === 'text') {
      text.push(stringField(block, 'text') ?? '');
    } else if (type === 'thinking') {
      const thought = stringField(block, 'thinking');
      if (thought !== undefined) thinking.push(thought);
    } else if (type === 'tool_use') {
      calls.push({
        id: stringField(block, 'id') ?? `toolu_${calls.length}`,
        name: stringField(block, 'name') ?? '',
        arguments: claudeArguments(block.input),
        index: calls.length,
      });
    }
  }

  const reasoning = thinking.join('');
  const replay = replayOf(
    blocks.filter((block) =>
      ['thinking', 'redacted_thinking', 'text', 'tool_use'].includes(
        stringField(block, 'type') ?? '',
      ),
    ),
  );

  return {
    text: text.join(''),
    finishReason,
    ...(usage === undefined ? {} : { usage }),
    ...(reasoning === '' ? {} : { reasoning: { text: reasoning } }),
    toolCalls: calls,
    ...(replay === undefined ? {} : { replay }),
  };
};

type StreamEvent = Exclude<
  ProviderStreamEvent,
  { readonly type: 'response.finished' }
>;

/**
 * One stream payload's events, which also fold into the state. A stream
 * ends with `message_stop`, so this never returns a `response.finished`;
 * the caller emits the finish from the accumulated state. A tool call is
 * announced done only when its block closed on JSON a tool can take: a block
 * a `max_tokens` stop cut off is never a call.
 */
export const claudeStreamEvents = (
  payload: Record<string, unknown>,
  state: ClaudeStreamState,
): readonly StreamEvent[] => {
  const events: StreamEvent[] = [];
  const type = stringField(payload, 'type');

  if (type === 'message_start') {
    const message = recordField(payload, 'message') ?? {};
    mergeUsage(recordField(message, 'usage'), state, events);

    return events;
  }

  if (type === 'content_block_start') {
    const index = numberField(payload, 'index') ?? 0;
    const block = recordField(payload, 'content_block') ?? {};
    const blockType = stringField(block, 'type') ?? '';

    state.blocks.set(index, {
      type: blockType,
      ...(blockType === 'tool_use'
        ? {
            id: stringField(block, 'id') ?? `toolu_${index}`,
            name: stringField(block, 'name') ?? '',
          }
        : {}),
      ...(blockType === 'redacted_thinking'
        ? { data: stringField(block, 'data') ?? '' }
        : {}),
      content:
        blockType === 'text'
          ? (stringField(block, 'text') ?? '')
          : blockType === 'thinking'
            ? (stringField(block, 'thinking') ?? '')
            : '',
      signature: stringField(block, 'signature') ?? '',
      done: false,
    });

    return events;
  }

  if (type === 'content_block_delta') {
    const index = numberField(payload, 'index') ?? 0;
    const delta = recordField(payload, 'delta') ?? {};
    const deltaType = stringField(delta, 'type');
    const block =
      state.blocks.get(index) ?? implicitBlock(state, index, deltaType);

    if (deltaType === 'text_delta') {
      const text = deltaEvent('text.delta', stringField(delta, 'text'));

      if (text !== undefined) {
        if (block !== undefined) block.content += text.delta;
        events.push(text);
      }

      return events;
    }

    if (deltaType === 'thinking_delta') {
      const reasoning = deltaEvent(
        'reasoning.delta',
        stringField(delta, 'thinking'),
      );

      if (reasoning !== undefined) {
        if (block !== undefined) block.content += reasoning.delta;
        events.push(reasoning);
      }

      return events;
    }

    if (deltaType === 'signature_delta') {
      if (block !== undefined) {
        block.signature += stringField(delta, 'signature') ?? '';
      }

      return events;
    }

    if (deltaType === 'input_json_delta') {
      const partial = stringField(delta, 'partial_json');

      if (partial !== undefined && block?.type === 'tool_use') {
        block.content += partial;

        events.push({
          type: 'tool_call.delta',
          index,
          id: block.id,
          name: block.name,
          argumentsDelta: partial,
        });
      }
    }

    return events;
  }

  if (type === 'content_block_stop') {
    const index = numberField(payload, 'index') ?? 0;
    const block = state.blocks.get(index);

    if (block !== undefined) {
      block.done = true;
      const call = streamCall(index, block);

      if (call !== undefined) {
        events.push({ type: 'tool_call.done', call });
      }
    }

    return events;
  }

  if (type === 'message_delta') {
    const delta = recordField(payload, 'delta') ?? {};
    const reason = claudeFinishReason(stringField(delta, 'stop_reason'));

    if (reason !== undefined) {
      state.finishReason = reason;
    }

    if (reason === 'content_filter') {
      state.refusal = refusalOf(
        recordField(delta, 'stop_details') ??
          recordField(payload, 'stop_details'),
      );
    }

    mergeUsage(recordField(payload, 'usage'), state, events);

    return events;
  }

  if (type === 'message_stop') {
    state.stopped = true;
  }

  return events;
};

/**
 * The block a text or thinking delta writes to when no `content_block_start`
 * opened one: a stream that skipped the start still keeps what it said.
 */
const implicitBlock = (
  state: ClaudeStreamState,
  index: number,
  deltaType: string | undefined,
): StreamBlock | undefined => {
  const type =
    deltaType === 'text_delta'
      ? 'text'
      : deltaType === 'thinking_delta'
        ? 'thinking'
        : undefined;
  if (type === undefined) return undefined;
  const block: StreamBlock = { type, content: '', signature: '', done: false };
  state.blocks.set(index, block);
  return block;
};

/**
 * A stream block as the tool call it names: a `tool_use` block that closed
 * on JSON a tool can take (one with no JSON at all is the empty object).
 */
const streamCall = (
  index: number,
  block: StreamBlock,
): ProviderToolCall | undefined => {
  if (block.type !== 'tool_use' || !block.done) return undefined;
  const json = block.content === '' ? '{}' : block.content;
  if (!parsesAsInput(json)) return undefined;
  return {
    id: block.id ?? `toolu_${index}`,
    name: block.name ?? '',
    arguments: json,
    index,
  };
};

/** Whether a stream payload reports an Anthropic error instead of progress. */
export const isClaudeStreamError = (
  payload: Record<string, unknown>,
): boolean =>
  payload.type === 'error' || recordField(payload, 'error') !== undefined;

/** The Anthropic error types a retry can outlast. */
const retryableErrorTypes = new Set([
  'overloaded_error',
  'api_error',
  'rate_limit_error',
]);

/**
 * An Anthropic error envelope (`{type:'error', error:{type,message}}`) as
 * its type, message and whether a retry can outlast it.
 */
export const claudeErrorOf = (
  payload: Record<string, unknown>,
): {
  readonly type?: string;
  readonly message?: string;
  readonly retryable: boolean;
  readonly code?: string;
} => {
  const error = recordField(payload, 'error') ?? {};
  const type = stringField(error, 'type');
  const details = recordField(error, 'details');
  const code =
    details === undefined ? undefined : stringField(details, 'error_code');
  return {
    type,
    message: stringField(error, 'message'),
    // A spend cap stays reached however long a retry waits.
    retryable:
      type !== undefined &&
      retryableErrorTypes.has(type) &&
      code !== 'enforced_spend_limit_reached',
    ...(code === undefined ? {} : { code }),
  };
};

/**
 * The accumulated state as a finish: what the stream showed, in the order it
 * showed it. Only calls whose blocks closed on valid JSON are calls; a
 * refused answer keeps no text, calls or replay, and says why it was refused.
 */
export const claudeStreamFinish = (
  state: ClaudeStreamState,
): ProviderFinished => {
  const ordered = [...state.blocks.entries()].sort(
    ([left], [right]) => left - right,
  );
  const finishReason = state.finishReason ?? 'unknown';

  if (finishReason === 'content_filter') {
    return {
      text: '',
      finishReason,
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      refusal: state.refusal ?? refusalOf(undefined),
      toolCalls: [],
    };
  }

  const calls = ordered.flatMap(([index, block]) => {
    const call = streamCall(index, block);
    return call === undefined ? [] : [call];
  });
  const text = ordered
    .filter(([, block]) => block.type === 'text')
    .map(([, block]) => block.content)
    .join('');
  const reasoning = ordered
    .filter(([, block]) => block.type === 'thinking')
    .map(([, block]) => block.content)
    .join('');
  const replay = replayOf(
    ordered.flatMap<Record<string, unknown>>(([index, block]) => {
      if (!block.done) return [];
      if (block.type === 'thinking') {
        return [
          {
            type: 'thinking',
            thinking: block.content,
            signature: block.signature,
          },
        ];
      }
      if (block.type === 'redacted_thinking') {
        return [{ type: 'redacted_thinking', data: block.data ?? '' }];
      }
      if (block.type === 'text') {
        return block.content === ''
          ? []
          : [{ type: 'text', text: block.content }];
      }
      const call = streamCall(index, block);
      return call === undefined
        ? []
        : [
            {
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: JSON.parse(call.arguments) as unknown,
            },
          ];
    }),
  );

  return {
    text,
    finishReason,
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    ...(reasoning === '' ? {} : { reasoning: { text: reasoning } }),
    toolCalls: calls,
    ...(replay === undefined ? {} : { replay }),
  };
};

/**
 * A payload's usage merged into what the stream reported before, as an event
 * and as the state the finish reports. `message_start` carries the input and
 * cache counts and `message_delta` the output count, so each event carries
 * the merged counts — never one payload's part.
 */
const mergeUsage = (
  usage: Record<string, unknown> | undefined,
  state: ClaudeStreamState,
  events: StreamEvent[],
): void => {
  if (usage === undefined) {
    return;
  }

  // Only numbers merge: a later payload's `null` count does not erase an
  // earlier one's. The thinking count arrives nested, on the final delta.
  const counts = { ...state.counts };
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number') counts[key] = value;
  }
  const details = recordField(usage, 'output_tokens_details');
  const thinking =
    details === undefined ? undefined : numberField(details, 'thinking_tokens');
  if (thinking !== undefined) counts.thinking_tokens = thinking;
  state.counts = counts;

  const merged = claudeUsage(counts);
  if (merged === undefined) {
    return;
  }

  state.usage = merged;

  events.push({ type: 'usage', usage: merged });
};

/** The arguments a finished `tool_use` block carries, stringified; a missing one is `{}`. */
const claudeArguments = (input: unknown): string => {
  const json = JSON.stringify(input);

  return json === undefined ? '{}' : json;
};
