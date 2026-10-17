import type { Storage } from 'bundle/contracts';

import {
  historyType,
  migrationType,
  projectType,
  threadType,
} from '../../contracts/storage.js';
import { createDocumentSet } from './documents.js';
import { createProjectStore } from './projects.js';
import { createThreadStore, type ThreadStoreOptions } from './threads.js';
import type { ProjectStore, ThreadStore } from './types.js';

/*
 * The runtime's durable boundary on `storage/v1` (design 57 §3). The host
 * part defines `runtimeStorageTypes` on activation and builds the two
 * stores over one document set, so a write through either store is seen by
 * the other's cache.
 */

/** Every storage type the runtime owns, for `storage/v1.defineType`. */
export const runtimeStorageTypes = [
  projectType,
  threadType,
  historyType,
  migrationType,
] as const;

export interface RuntimeStores {
  readonly projects: ProjectStore;
  readonly threads: ThreadStore;
}

export const createRuntimeStores = (
  storage: Storage,
  options: ThreadStoreOptions,
): RuntimeStores => {
  const set = createDocumentSet(storage);
  return {
    projects: createProjectStore(set),
    threads: createThreadStore(set, options),
  };
};

export { foldAll, foldProgress, type ProgressEntry } from './progress.js';
export {
  queuedPrompt,
  queuedPrompts,
  queueSnapshot,
  resumablePrompt,
  storageQueueError,
} from './queue.js';
export { storable } from './records.js';
export type { RewindParticipation, ThreadStoreOptions } from './threads.js';
export type * from './types.js';
export {
  addTotals,
  emptyTotals,
  emptyUsage,
  projectUsage,
  type UsageState,
  usageTotals,
} from './usage.js';
