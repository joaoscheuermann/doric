/**
 * Protocol helpers shared by `storage.backend/v1` implementations and the
 * `storage/v1` facade: index key encoding, query cursors, stream IDs,
 * conflict and limit errors, and batch accounting. Bundles never import this
 * package; backend authors and their tests do.
 */
export {
  batchSize,
  checkBatchLimits,
  defaultStorageCapabilities,
  jsonBytes,
} from './batch.js';
export { type CursorPosition, decodeCursor, encodeCursor } from './cursor.js';
export {
  limitExceeded,
  revisionConflict,
  sequenceConflict,
  uniqueConflict,
} from './errors.js';
export {
  compareBytes,
  compareIds,
  decodeIndexKey,
  encodeIndexKey,
  type IndexScalar,
  indexValues,
  keyBounds,
  toJsonPointer,
} from './keys.js';
export { parseStreamId, type StreamId, streamIdPattern } from './streams.js';
