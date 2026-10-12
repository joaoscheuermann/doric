/**
 * In-memory `storage.backend/v1` and `secrets.backend/v1`: the executable
 * reference of the storage protocol, and the foundation of core and kernel
 * unit tests. Never part of a shipped composition.
 */
export {
  type MemoryFoundationOptions,
  memoryFoundation,
} from './foundation.js';
export {
  type MemorySecretsOptions,
  memorySecretsBackend,
} from './secrets-backend.js';
export {
  type MemoryStorageOptions,
  memoryStorageBackend,
} from './storage-backend.js';
export {
  createMemoryStore,
  type MemoryCommit,
  type MemoryDocument,
  type MemoryIndex,
  type MemoryStore,
  type MemoryStream,
  type MemoryStreamEntry,
  type MemoryTruncation,
} from './store.js';
