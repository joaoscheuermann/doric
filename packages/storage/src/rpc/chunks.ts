// Chunked values of the data-only storage contracts until phase 4 (spec
// `docs/designs/grpc-processes.md`, section 17, "Storage until phase 4";
// section 3, "Size", rule 3): a value crosses as its JSON text in UTF-8, in
// `bytes` items of at most 1 MiB. Phase 4 deletes this file with
// `storage.backend/v1`.

import { ContractError } from 'bundle/contracts';

/** The most bytes one chunk holds: 1 MiB (1,048,576), the proto's `max_len`. */
export const maxChunkBytes = 1_048_576;

/**
 * The code a decoding failure raises: `invalid_input` where the chunks came
 * in a request (the serving side), `invalid_output` where they came in an
 * answer (the calling side).
 */
export type ChunkFailure = 'invalid_input' | 'invalid_output';

/**
 * Splits `bytes` into consecutive chunks of at most {@link maxChunkBytes}
 * each, none empty, whose concatenation is `bytes`, in order. Zero bytes
 * give `[]`; exactly `maxChunkBytes` give one chunk, one byte more two.
 * Never throws. The chunks are views of `bytes`' buffer: the caller does not
 * change `bytes` while it uses them.
 */
export const chunkBytes = (bytes: Uint8Array): Uint8Array[] => {
  const chunks: Uint8Array[] = [];

  for (let start = 0; start < bytes.length; start += maxChunkBytes) {
    chunks.push(bytes.subarray(start, start + maxChunkBytes));
  }

  return chunks;
};

/**
 * The concatenation of `chunks`, in order, in a new array; `[]` gives zero
 * bytes. Never throws, and never changes its input.
 */
export const joinChunks = (chunks: readonly Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return joined;
};

/**
 * A value's JSON text (`JSON.stringify(value)`) in UTF-8, split as
 * {@link chunkBytes} splits it, so always at least one chunk. A value
 * `JSON.stringify` answers `undefined` for (`undefined`, a function, a
 * symbol) is encoded as `null`, as the backends store it and as
 * `jsonBytes` counts it (`packages/storage/src/batch.ts`).
 *
 * Throws `ContractError` `invalid_input` when `JSON.stringify` throws (a
 * `BigInt`, a cycle), with the thrown error's message; nothing is sent then.
 */
export const encodeJson = (value: unknown): Uint8Array[] => {
  let text: string | undefined;

  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new ContractError(
      'invalid_input',
      error instanceof Error ? error.message : String(error),
    );
  }

  return chunkBytes(new TextEncoder().encode(text ?? 'null'));
};

/**
 * The value whose JSON text `chunks` hold: the concatenation decoded as
 * UTF-8, then `JSON.parse`d. A code point split across two chunks decodes
 * whole, so `decodeJson(encodeJson(v), f)` deep-equals
 * `JSON.parse(JSON.stringify(v) ?? 'null')` for every `v` `encodeJson`
 * accepts.
 *
 * Throws `ContractError` with code `failure` when `chunks` is empty, when
 * the bytes are not valid UTF-8 (no replacement character is substituted),
 * or when the text is not JSON.
 */
export const decodeJson = (
  chunks: readonly Uint8Array[],
  failure: ChunkFailure,
): unknown => {
  if (chunks.length === 0) {
    throw new ContractError(failure, 'A value arrived without any chunk.');
  }

  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(joinChunks(chunks)),
    ) as unknown;
  } catch (error) {
    throw new ContractError(
      failure,
      `A value is not UTF-8 JSON text: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
