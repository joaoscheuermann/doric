import type {
  ProviderFinished,
  ProviderReplayItem,
  ProviderStreamEvent,
  ProviderToolCall,
  ReasoningMetadata,
} from '../../types/provider.js';
import {
  arrayField,
  asRecord,
  recordField,
  stringField,
} from '../../utils/json.js';
import { finishReason, parseUsage } from '../common.js';

export type TextSnapshots = {
  readonly outputItems: string[];
  readonly outputTexts: string[];
  readonly contentParts: string[];
};

export const createTextSnapshots = (): TextSnapshots => ({
  outputItems: [],
  outputTexts: [],
  contentParts: [],
});

export const streamEvent = (
  payload: Record<string, unknown>,
  calls: Map<number, ProviderToolCall>,
):
  | Exclude<ProviderStreamEvent, { readonly type: 'response.finished' }>
  | undefined => {
  const type = stringField(payload, 'type');

  if (type === 'response.output_text.delta') {
    return { type: 'text.delta', delta: stringField(payload, 'delta') ?? '' };
  }

  if (
    type === 'response.reasoning_summary_text.delta' ||
    type === 'response.reasoning_text.delta'
  ) {
    return {
      type: 'reasoning.delta',
      delta: stringField(payload, 'delta') ?? '',
    };
  }

  if (type === 'response.refusal.delta') {
    return {
      type: 'refusal.delta',
      delta: stringField(payload, 'delta') ?? '',
    };
  }

  if (type === 'response.function_call_arguments.delta') {
    const index = Number(payload.output_index ?? payload.item_index ?? 0);
    const previous = calls.get(index);
    const delta = stringField(payload, 'delta') ?? '';

    const next = {
      id: previous?.id ?? stringField(payload, 'item_id') ?? `call_${index}`,
      name: previous?.name ?? stringField(payload, 'name') ?? '',
      arguments: `${previous?.arguments ?? ''}${delta}`,
      index,
    };

    calls.set(index, next);

    return {
      type: 'tool_call.delta',
      index,
      id: next.id,
      name: next.name,
      argumentsDelta: delta,
    };
  }

  if (type === 'response.output_item.done') {
    const item = recordField(payload, 'item');

    if (item?.type !== 'function_call') {
      return undefined;
    }

    const index = Number(payload.output_index ?? 0);

    const call = {
      id:
        stringField(item, 'call_id') ??
        stringField(item, 'id') ??
        `call_${index}`,
      name: stringField(item, 'name') ?? '',
      arguments:
        stringField(item, 'arguments') ?? calls.get(index)?.arguments ?? '',
      index,
    };

    calls.set(index, call);

    return { type: 'tool_call.done', call };
  }

  return undefined;
};

export const recordTextSnapshot = (
  snapshots: TextSnapshots,
  payload: Record<string, unknown>,
): void => {
  const type = stringField(payload, 'type');
  const text = textSnapshot(type, payload);

  if (text === undefined || text === '') {
    return;
  }

  if (type === 'response.output_item.done') {
    snapshots.outputItems.push(text);

    return;
  }

  if (type === 'response.output_text.done') {
    snapshots.outputTexts.push(text);

    return;
  }

  snapshots.contentParts.push(text);
};

export const streamText = (
  deltas: readonly string[],
  snapshots: TextSnapshots,
): string | undefined => {
  const deltaText = deltas.join('');

  if (deltaText !== '') {
    return deltaText;
  }

  return (
    snapshotGroupText(snapshots.outputItems) ??
    snapshotGroupText(snapshots.outputTexts) ??
    snapshotGroupText(snapshots.contentParts)
  );
};

export const parseFinished = (
  response: Record<string, unknown>,
  streamText?: string,
  streamReasoning?: string,
  streamRefusal?: string,
  streamToolCalls: readonly ProviderToolCall[] = [],
): ProviderFinished => {
  const output = arrayField(response, 'output').map(asRecord).filter(isRecord);

  const content = output
    .flatMap((item) => arrayField(item, 'content'))
    .map(asRecord)
    .filter(isRecord);

  const contentText = content
    .filter((item) => item.type === 'output_text')
    .map((item) => stringField(item, 'text') ?? '')
    .join('');

  const outputText =
    streamText ??
    nonEmptyText(stringField(response, 'output_text')) ??
    contentText;

  const refusal =
    stringField(response, 'refusal') ??
    streamRefusal ??
    content
      .filter((item) => item.type === 'refusal')
      .map(
        (item) =>
          stringField(item, 'refusal') ?? stringField(item, 'text') ?? '',
      )
      .join('');

  const responseToolCalls = output
    .filter((item) => item.type === 'function_call')
    .map((item, index) => ({
      id:
        stringField(item, 'call_id') ??
        stringField(item, 'id') ??
        `call_${index}`,
      name: stringField(item, 'name') ?? '',
      arguments: stringField(item, 'arguments') ?? '',
      index,
    }));
  const toolCalls =
    responseToolCalls.length === 0 ? streamToolCalls : responseToolCalls;

  const reasoningText =
    streamReasoning ??
    output
      .filter((item) => item.type === 'reasoning')
      .flatMap((item) => arrayField(item, 'summary'))
      .map(asRecord)
      .filter(isRecord)
      .map((summary) => stringField(summary, 'text') ?? '')
      .join('');
  const usage = parseUsage(recordField(response, 'usage'));
  const reasoning: ReasoningMetadata | undefined =
    reasoningText === '' ? undefined : { text: reasoningText };

  return {
    text: outputText,
    finishReason:
      toolCalls.length > 0
        ? 'tool_calls'
        : refusal !== ''
          ? 'content_filter'
          : finishReason(
              response.status === 'completed' ? 'stop' : response.status,
            ),
    usage,
    reasoning,
    refusal: refusal === '' ? undefined : refusal,
    toolCalls,
    ...(output.length === 0
      ? {}
      : { replay: output as readonly ProviderReplayItem[] }),
  };
};

const textSnapshot = (
  type: string | undefined,
  payload: Record<string, unknown>,
): string | undefined => {
  if (type === 'response.output_text.done') {
    return stringField(payload, 'text');
  }

  if (type === 'response.content_part.done') {
    return contentPartText(recordField(payload, 'part'));
  }

  if (type === 'response.output_item.done') {
    return outputItemText(recordField(payload, 'item'));
  }

  return undefined;
};

const snapshotGroupText = (items: readonly string[]): string | undefined => {
  const text = items.join('');

  return text === '' ? undefined : text;
};

const outputItemText = (
  item: Record<string, unknown> | undefined,
): string | undefined => {
  if (item?.type === 'output_text') {
    return stringField(item, 'text');
  }

  if (item?.type !== 'message') {
    return undefined;
  }

  return contentText(item);
};

const contentPartText = (
  part: Record<string, unknown> | undefined,
): string | undefined =>
  part?.type === 'output_text' ? stringField(part, 'text') : undefined;

const contentText = (item: Record<string, unknown>): string =>
  arrayField(item, 'content')
    .map(asRecord)
    .filter(isRecord)
    .filter((content) => content.type === 'output_text')
    .map((content) => stringField(content, 'text') ?? '')
    .join('');

const nonEmptyText = (value: string | undefined): string | undefined =>
  value === '' ? undefined : value;

const isRecord = (
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> => value !== undefined;
