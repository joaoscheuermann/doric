/**
 * The entry `storage`: the `storage/v2` client a bundle opens in its
 * activation (`openStorage`, `Storage` and its types); `storage.kv/v1`'s
 * `Kv`; and the protocol helpers shared by `storage.backend/v1`
 * implementations and the `storage/v1` facade: index key encoding, query
 * cursors, stream IDs, conflict and limit errors, and batch accounting.
 */
export {
  batchSize,
  checkBatchLimits,
  defaultStorageCapabilities,
  jsonBytes,
} from './batch.js';
export { openStorage } from './client/index.js';
export type {
  CommitBatch,
  CommitResult,
  DocumentKey,
  DocumentPut,
  ExpectedRevision,
  Storage,
  StorageHealth,
  StoragePage,
  StorageQuery,
  StoredDocument,
  StreamAppend,
  StreamEntry,
  StreamPage,
  StreamRead,
  TruncationMark,
} from './client/types.js';
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
export { type Kv, kvClient, kvLimits } from './kv.js';
export { parseStreamId, type StreamId, streamIdPattern } from './streams.js';
