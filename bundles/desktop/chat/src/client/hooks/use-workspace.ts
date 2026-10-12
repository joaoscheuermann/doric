// The chat's reading of `layout.workspace/v1` (D9-9): the sidebar tree's
// records, re-read whenever the tree, the selection or the provider itself
// changes. Without a layout bundle every read is `undefined`.

import { useRef, useSyncExternalStore } from 'react';

import type { LayoutWorkspace } from '../api/workspace-contract.js';
import type { Thread } from '../domain/workspace.js';
import {
  currentWorkspace,
  subscribeWorkspaceProvider,
} from '../services/chat-services.js';

let version = 0;
const listeners = new Set<() => void>();
let attached: { dispose(): void } | undefined;
let detachProvider: (() => void) | undefined;

const bump = (): void => {
  version += 1;
  for (const listener of [...listeners]) listener();
};

/** Follows the current provider while anything listens. */
const attach = (): void => {
  attached?.dispose();
  attached = undefined;
  const workspace = currentWorkspace();
  if (workspace === undefined) return;
  try {
    attached = workspace.subscribe(bump);
  } catch {
    // A provider that cannot be followed is read on the next provider change.
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    detachProvider = subscribeWorkspaceProvider(() => {
      attach();
      bump();
    });
    attach();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    detachProvider?.();
    detachProvider = undefined;
    attached?.dispose();
    attached = undefined;
  };
};

const snapshot = (): number => version;

const read = <T>(run: (workspace: LayoutWorkspace) => T): T | undefined => {
  const workspace = currentWorkspace();
  if (workspace === undefined) return undefined;
  try {
    return run(workspace);
  } catch {
    return undefined;
  }
};

/**
 * Re-renders on every workspace change and returns its version, so a reader
 * can memoize what it derives from the tree.
 */
export const useWorkspaceVersion = (): number =>
  useSyncExternalStore(subscribe, snapshot, snapshot);

/** Whether a `layout.workspace/v1` provider is available. */
export const useHasWorkspace = (): boolean => {
  useWorkspaceVersion();
  return currentWorkspace() !== undefined;
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

/** The tree's record of one Thread, when the tree holds it. */
export const useWorkspaceThread = (
  threadId: string | undefined,
): Thread | undefined => {
  useWorkspaceVersion();
  return useStableThread(
    threadId === undefined
      ? undefined
      : read((workspace) => workspace.thread(threadId)),
  );
};

/** The record of the Thread the window selects. */
export const useSelectedThread = (): Thread | undefined => {
  useWorkspaceVersion();
  return useStableThread(read((workspace) => workspace.selectedThread()));
};
