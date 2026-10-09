import {
  type CommitBatch,
  ContractError,
  type StorageCapabilities,
} from 'bundle/contracts';

import { limitExceeded } from './errors.js';

/**
 * The limits a backend reports when it is not configured otherwise: up to
 * 10 000 items per batch, so one atomic Project deletion fits, and the
 * PostgreSQL jsonb ceiling per document and per appended event.
 */
export const defaultStorageCapabilities: StorageCapabilities = Object.freeze({
  maxBatch: 10_000,
  maxDocumentBytes: 268_435_455,
  maxAppendBytes: 268_435_455,
});

/** Items in a batch: expect + put + delete + dropStreams + truncate (1) + appended events. */
export const batchSize = (batch: CommitBatch): number =>
  (batch.expect?.length ?? 0) +
  (batch.put?.length ?? 0) +
  (batch.delete?.length ?? 0) +
  (batch.dropStreams?.length ?? 0) +
  (batch.truncate === undefined ? 0 : 1) +
  (batch.append ?? []).reduce((total, entry) => total + entry.events.length, 0);

/** The UTF-8 size of a value's JSON text; `undefined` counts as `null`. */
export const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

/**
 * Refuses a batch before anything is written: an empty batch is
 * `invalid_input`; one over `maxBatch` items, a put value over
 * `maxDocumentBytes` or an appended event over `maxAppendBytes` is
 * `limit_exceeded`.
 */
export const checkBatchLimits = (
  batch: CommitBatch,
  limits: StorageCapabilities,
): void => {
  const size = batchSize(batch);

  if (size === 0) {
    throw new ContractError(
      'invalid_input',
      'A commit batch must hold at least one item.',
    );
  }

  if (size > limits.maxBatch) {
    throw limitExceeded('batch', limits.maxBatch);
  }

  for (const put of batch.put ?? []) {
    if (jsonBytes(put.value) > limits.maxDocumentBytes) {
      throw limitExceeded('document', limits.maxDocumentBytes);
    }
  }

  for (const append of batch.append ?? []) {
    for (const event of append.events) {
      if (jsonBytes(event) > limits.maxAppendBytes) {
        throw limitExceeded('append', limits.maxAppendBytes);
      }
    }
  }
};
