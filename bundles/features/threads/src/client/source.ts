// Where a delegated input came from (from the renderer's
// `hooks/use-delegated-source.ts`): the sender's record in
// `runtime.records/v1` (read through `whenAvailable`), and opening it by
// navigating to its conversation, which selects it.

import {
  type Disposable,
  NavigationV1,
  ref,
  type Services,
} from 'bundle/contracts';
import { useSyncExternalStore } from 'react';
import type { RuntimeRecords, Thread } from 'runtime/contracts';

import { threadLabel } from './domain/delegated.js';

/** The part of `runtime.records/v1` threads reads. */
export type RecordsSource = Pick<RuntimeRecords, 'thread' | 'subscribe'>;

/** Optional, so built from its id with the type imported (D32). */
export const RuntimeRecordsV1 = ref<RecordsSource>('runtime.records/v1');

let records: RecordsSource | undefined;
let attached: Disposable | undefined;
const listeners = new Set<() => void>();

const bump = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Follows the current provider; `undefined` when it leaves. */
export const setRecords = (next: RecordsSource | undefined): void => {
  attached?.dispose();
  attached = undefined;
  records = next;
  if (next !== undefined) {
    try {
      attached = next.subscribe(bump);
    } catch {
      // A provider that cannot be followed is read on the next change.
    }
  }
  bump();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = (threadId: string): Thread | undefined => {
  if (records === undefined) return undefined;
  try {
    return records.thread(threadId);
  } catch {
    return undefined;
  }
};

export const threadPath = (projectId: string, threadId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;

/**
 * Resolve a sender from the already loaded records without opening a
 * subscription. Opening it navigates to its conversation.
 */
export function useDelegatedSource(threadId: string, services: Services) {
  // The two fields drawn are the snapshots, so a records change that leaves
  // them alone (another Thread's lifecycle) does not re-render the block.
  const projectIdOf = () => read(threadId)?.projectId;
  const nameOf = () => read(threadId)?.name;
  const projectId = useSyncExternalStore(subscribe, projectIdOf, projectIdOf);
  const name = useSyncExternalStore(subscribe, nameOf, nameOf);
  return {
    label: threadLabel(threadId, name),
    open:
      projectId === undefined
        ? undefined
        : () =>
            services
              .use(NavigationV1)
              .navigate(threadPath(projectId, threadId)),
  };
}
