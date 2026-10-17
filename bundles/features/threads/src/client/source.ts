// Where a delegated input came from (from the renderer's
// `hooks/use-delegated-source.ts`): the sender's record in the layout's
// sidebar tree (`layout.workspace/v1`, read through `whenAvailable`), and
// opening it by navigating to its conversation, which selects it.

import {
  type CallArg,
  type Disposable,
  NavigationV1,
  ref,
  type Services,
} from 'bundle/contracts';
import { useSyncExternalStore } from 'react';

import { threadLabel } from './domain/delegated.js';

/** The layout's record of a Thread, as far as this bundle reads it. */
export interface WorkspaceThread {
  readonly id: string;
  readonly projectId: string;
  readonly name?: string;
}

/** A structural copy of the part of `layout.workspace/v1` threads reads. */
export interface LayoutWorkspace {
  thread(threadId: string, call?: CallArg): WorkspaceThread | undefined;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');

let workspace: LayoutWorkspace | undefined;
let attached: Disposable | undefined;
const listeners = new Set<() => void>();

const bump = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Follows the current provider; `undefined` when it leaves. */
export const setWorkspace = (next: LayoutWorkspace | undefined): void => {
  attached?.dispose();
  attached = undefined;
  workspace = next;
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
const read = (threadId: string): WorkspaceThread | undefined => {
  if (workspace === undefined) return undefined;
  try {
    return workspace.thread(threadId);
  } catch {
    return undefined;
  }
};

export const threadPath = (projectId: string, threadId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;

/**
 * Resolve a sender from the already loaded tree without opening a
 * subscription. Opening it navigates to its conversation.
 */
export function useDelegatedSource(threadId: string, services: Services) {
  // The two fields drawn are the snapshots, so a workspace change that leaves
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
