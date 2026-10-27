// The MCP client's one hook: a snapshot read through a store's `subscribe`
// (the screen bundle's own copy, kept per bundle as the layout keeps its read
// helpers).

import type { Disposable } from 'bundle/contracts';
import { useSyncExternalStore } from 'react';

/** A snapshot read through `subscribe(listener): Disposable`, re-read after every notification. */
export const useSubscribed = <T>(
  source: { readonly subscribe: (listener: () => void) => Disposable },
  read: () => T,
): T =>
  useSyncExternalStore((notify) => {
    const subscription = source.subscribe(notify);
    return () => subscription.dispose();
  }, read);
