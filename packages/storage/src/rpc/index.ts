/**
 * `storage/rpc`: the data-only storage contracts of phases 0 to 3 over the
 * router (spec `docs/designs/grpc-processes.md`, section 17, "Storage until
 * phase 4"): the chunked JSON codec, and a server and a client adapter for
 * `storage.backend/v1`, `secrets.backend/v1` and `storage/v1`. Phase 4
 * deletes it.
 */
export {
  type ChunkFailure,
  chunkBytes,
  decodeJson,
  encodeJson,
  joinChunks,
  maxChunkBytes,
} from './chunks.js';
export { serveStorageBackend, storageBackendClient } from './backend.js';
export { secretsBackendClient, serveSecretsBackend } from './secrets.js';
export {
  type ServeStorageOptions,
  type StorageClient,
  type StorageClientOptions,
  type StorageFacade,
  serveStorage,
  storageClient,
} from './storage.js';
