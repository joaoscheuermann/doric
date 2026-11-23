// History parts as chunked stream items (phase 3, slice S48b): what
// `executor.session/v1.ReadHistory` answers and what `executor/v1`'s
// `Checkpoint` and `Rewind` streams carry.

import type { MessageInitShape } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import { decodeJson, encodeJson } from 'storage/rpc';

import type { HistoryPatch } from '../../contracts/executor.js';
import type { ReadHistoryResponseSchema } from '../../contracts/gen/doric/executor/session/v1/session_pb.js';
import type {
  CheckpointResponse,
  RewindResponse,
} from '../../contracts/gen/doric/executor/v1/executor_pb.js';
import { routed } from './errors.js';

/**
 * `ReadHistory`'s items: `{head: {format?}}` (absent format when the reader
 * has none), then, unless `value` is `undefined`, `encodeJson(value)`'s
 * chunks (each ≤ 1 MiB, never empty). Throws what `encodeJson` throws.
 */
export const readHistoryItems = (
  format: string | undefined,
  value: unknown,
): MessageInitShape<typeof ReadHistoryResponseSchema>[] => [
  { item: { case: 'head', value: format === undefined ? {} : { format } } },
  ...(value === undefined
    ? []
    : encodeJson(value).map((chunk) => ({
        item: { case: 'chunk' as const, value: chunk },
      }))),
];

/**
 * The `HistoryPatch` a `Checkpoint` or `Rewind` stream carries: a first
 * `format`, then per part its `part` name followed by ≥ 1 `chunk`s, decoded
 * with `decodeJson(…, 'invalid_output')`. Resolves `undefined` for a stream
 * with no item. Rejects `ContractError('invalid_output')` (INTERNAL) when the
 * first item is not `format`, a second `format` arrives, a `chunk` precedes
 * any `part`, a part has no chunk, a part name repeats, or a part's text is
 * not UTF-8 JSON. A failure of `items` itself rejects as `routedError` reads
 * it. Consumes `items` to the end.
 */
export const historyPatchOf = (
  items: AsyncIterable<CheckpointResponse | RewindResponse>,
): Promise<HistoryPatch | undefined> =>
  routed(async () => {
    const invalid = (message: string) =>
      new ContractError('invalid_output', message);
    let format: string | undefined;
    let failure: ContractError | undefined;
    const parts = new Map<string, Uint8Array[]>();
    let current: Uint8Array[] | undefined;
    // Consumed to the end even once malformed.
    for await (const { item } of items) {
      if (failure !== undefined) continue;
      const first = format === undefined;
      if (first !== (item.case === 'format')) {
        failure = invalid(
          first
            ? 'A history patch must start with its format.'
            : 'A history patch carries one format.',
        );
      } else if (item.case === 'format') {
        format = item.value;
      } else if (item.case === 'part') {
        if (current?.length === 0)
          failure = invalid('A history part arrived without any chunk.');
        else if (parts.has(item.value))
          failure = invalid(`History part ${item.value} arrived twice.`);
        else {
          current = [];
          parts.set(item.value, current);
        }
      } else if (item.case === 'chunk') {
        if (current === undefined)
          failure = invalid('A history chunk arrived before any part.');
        else current.push(item.value);
      }
    }
    if (failure !== undefined) throw failure;
    if (format === undefined) return undefined;
    if (current?.length === 0)
      throw invalid('A history part arrived without any chunk.');
    return {
      format,
      parts: Object.fromEntries(
        [...parts].map(([part, chunks]) => [
          part,
          decodeJson(chunks, 'invalid_output'),
        ]),
      ),
    };
  });
