// The host contracts the layout calls over the client → host bridge. The
// references are built here from the contract IDs, with the runtime's types
// only: a window's import map is not guaranteed to serve the runtime's
// contracts module, and a reference is its ID.

import { ref } from 'bundle/contracts';
import type { Runtime, RuntimeThreads } from 'runtime/contracts';

/** `runtime/v1`: Projects and the `/projects` watch (1.2.0). */
export const RuntimeV1 = ref<Runtime>('runtime/v1');

/** `runtime.threads/v1`: Threads of a Project. */
export const RuntimeThreadsV1 = ref<RuntimeThreads>('runtime.threads/v1');

/** The subset of `runtime/v1` the layout calls. */
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

/** The subset of `runtime.threads/v1` the layout calls. */
export type ThreadsHost = Pick<
  RuntimeThreads,
  | 'threads'
  | 'thread'
  | 'createThread'
  | 'renameThread'
  | 'terminateThread'
  | 'deleteThread'
>;
