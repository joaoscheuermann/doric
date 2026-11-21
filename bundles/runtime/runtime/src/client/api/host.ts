// The host contracts the records mirror calls over the client → host bridge.

import type { Runtime, RuntimeThreads } from '../../contracts/index.js';

export { RuntimeThreadsV1, RuntimeV2 } from '../../contracts/index.js';

/** The subset of `runtime/v2` the records mirror calls. */
export type RuntimeHost = Pick<
  Runtime,
  | 'projects'
  | 'projectActivity'
  | 'createProject'
  | 'renameProject'
  | 'setProjectColor'
  | 'terminateProject'
  | 'deleteProject'
  | 'watchProject'
>;

/**
 * The subset of `runtime.threads/v1` the records mirror calls. `archiveThread`,
 * `restoreThread`, `setThreadPinned` and `viewThread` need
 * `runtime.threads/v1@^1.8.0` (docs/designs/thread-archive.md §10.6, §10.8).
 */
export type ThreadsHost = Pick<
  RuntimeThreads,
  | 'threads'
  | 'thread'
  | 'createThread'
  | 'renameThread'
  | 'terminateThread'
  | 'deleteThread'
  | 'archiveThread'
  | 'restoreThread'
  | 'setThreadPinned'
  | 'viewThread'
>;
