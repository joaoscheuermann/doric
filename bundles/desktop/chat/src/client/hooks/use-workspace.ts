// The chat's reading of the window's Threads: their records from
// `runtime.records/v1` and the selected Thread's id from
// `workspace.selection/v1`, re-read whenever the records, the selection or
// the selection's provider change. Without a `workspace.selection/v1`
// provider nothing is selected and `useHasWorkspace` is false.

import { useRef, useSyncExternalStore } from 'react';
import { RuntimeRecordsV1 } from 'runtime/contracts';

import type { Thread } from '../domain/workspace.js';
import { chatServices } from '../services/chat-services.js';
import {
  currentWorkspaceSelection,
  subscribeExecutionSources,
} from '../stores/execution-sources.js';

let version = 0;
const listeners = new Set<() => void>();
let selectionAttached: { dispose(): void } | undefined;
let recordsAttached: { dispose(): void } | undefined;
let detachProvider: (() => void) | undefined;

const bump = (): void => {
  version += 1;
  for (const listener of [...listeners]) listener();
};

/** Follows the current selection provider while anything listens. */
const attachSelection = (): void => {
  selectionAttached?.dispose();
  selectionAttached = undefined;
  const selection = currentWorkspaceSelection();
  if (selection === undefined) return;
  try {
    selectionAttached = selection.subscribe(bump);
  } catch {
    // A provider that cannot be followed is read on the next provider change.
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    let selection = currentWorkspaceSelection();
    detachProvider = subscribeExecutionSources(() => {
      if (currentWorkspaceSelection() === selection) return;
      selection = currentWorkspaceSelection();
      attachSelection();
      bump();
    });
    attachSelection();
    try {
      recordsAttached = chatServices().use(RuntimeRecordsV1).subscribe(bump);
    } catch {
      // Records that cannot be followed are read on the next selection change.
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    detachProvider?.();
    detachProvider = undefined;
    selectionAttached?.dispose();
    selectionAttached = undefined;
    recordsAttached?.dispose();
    recordsAttached = undefined;
  };
};

const snapshot = (): number => version;

/** The records' Thread of an id, when they hold it. */
const recordOf = (threadId: string): Thread | undefined => {
  try {
    return chatServices().use(RuntimeRecordsV1).thread(threadId);
  } catch {
    return undefined;
  }
};

/** The id of the Thread the window selects, while a provider answers. */
const selectedThreadId = (): string | undefined => {
  try {
    return currentWorkspaceSelection()?.current().threadId;
  } catch {
    return undefined;
  }
};

/**
 * Re-renders on every change of the records or the selection and returns its
 * version, so a reader can memoize what it derives from them.
 */
export const useWorkspaceVersion = (): number =>
  useSyncExternalStore(subscribe, snapshot, snapshot);

/** Whether a `workspace.selection/v1` provider answers. */
export const useHasWorkspace = (): boolean => {
  useWorkspaceVersion();
  return currentWorkspaceSelection() !== undefined;
};

const same = (left: Thread | undefined, right: Thread | undefined): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    JSON.stringify(left) === JSON.stringify(right));

/**
 * Keeps the record the last render returned while its content is unchanged.
 * A record read through the service is a fresh copy on every call, and the
 * conversation keys its effects on the Thread's identity, as it did on the
 * store's record.
 */
const useStableThread = (next: Thread | undefined): Thread | undefined => {
  const previous = useRef<Thread | undefined>(undefined);
  if (!same(previous.current, next)) previous.current = next;
  return previous.current;
};

/** The records' Thread of an id, when they hold it. */
export const useWorkspaceThread = (
  threadId: string | undefined,
): Thread | undefined => {
  useWorkspaceVersion();
  return useStableThread(
    threadId === undefined ? undefined : recordOf(threadId),
  );
};

/** The records' Thread the window selects. */
export const useSelectedThread = (): Thread | undefined => {
  useWorkspaceVersion();
  const threadId = selectedThreadId();
  return useStableThread(
    threadId === undefined ? undefined : recordOf(threadId),
  );
};
