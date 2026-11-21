import type { Services } from 'bundle/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { type Usage, UsageV1 } from '../../contracts/index.js';
import {
  type SelectionSource,
  WorkspaceSelectionV1,
} from '../api/workspace.js';
import { ThreadUsage } from './thread-usage.js';

/** A contract's API while a provider serves it, else undefined. */
const useService = <T,>(
  services: Services,
  read: (
    services: Services,
    set: (api: T | undefined) => void,
  ) => {
    dispose(): void;
  },
): T | undefined => {
  const [api, setApi] = useState<T | undefined>(undefined);
  useEffect(() => {
    const binding = read(services, (next) => setApi(() => next));
    return () => binding.dispose();
  }, [services, read]);
  return api;
};

const bindUsage = (services: Services, set: (api: Usage | undefined) => void) =>
  services.whenAvailable(UsageV1, (api) => {
    set(api);
    return () => set(undefined);
  });

const bindSelection = (
  services: Services,
  set: (api: SelectionSource | undefined) => void,
) =>
  services.whenAvailable(WorkspaceSelectionV1, (api) => {
    set(api);
    return () => set(undefined);
  });

/** The id of the Thread the window selects, while the workspace serves it. */
const useSelectedThreadId = (
  selection: SelectionSource | undefined,
): string | undefined =>
  useSyncExternalStore(
    (notify) => {
      if (selection === undefined) return () => undefined;
      const subscription = selection.subscribe(notify);
      return () => subscription.dispose();
    },
    () => {
      if (selection === undefined) return undefined;
      try {
        return selection.current().threadId;
      } catch {
        return undefined;
      }
    },
  );

/** The footer's usage of the selected Thread; nothing without one. */
export function UsageSummary({ services }: { readonly services: Services }) {
  const usage = useService(services, bindUsage);
  const selection = useService(services, bindSelection);
  const threadId = useSelectedThreadId(selection);
  // Keyed by Thread, as the provisional footer remounted with its Thread.
  return <ThreadUsage key={threadId} threadId={threadId} usage={usage} />;
}
