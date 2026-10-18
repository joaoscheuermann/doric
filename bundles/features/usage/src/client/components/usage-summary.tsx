import type { Services } from 'bundle/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { type Usage, UsageV1 } from '../../contracts/index.js';
import { type SelectedThreadSource, WorkspaceV1 } from '../api/workspace.js';
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

const bindWorkspace = (
  services: Services,
  set: (api: SelectedThreadSource | undefined) => void,
) =>
  services.whenAvailable(WorkspaceV1, (api) => {
    set(api);
    return () => set(undefined);
  });

/** The id of the Thread the window selects, while the layout serves it. */
const useSelectedThreadId = (
  workspace: SelectedThreadSource | undefined,
): string | undefined =>
  useSyncExternalStore(
    (notify) => {
      if (workspace === undefined) return () => undefined;
      const subscription = workspace.subscribe(notify);
      return () => subscription.dispose();
    },
    () => {
      if (workspace === undefined) return undefined;
      try {
        return workspace.selectedThread()?.id;
      } catch {
        return undefined;
      }
    },
  );

/** The footer's usage of the selected Thread; nothing without one. */
export function UsageSummary({ services }: { readonly services: Services }) {
  const usage = useService(services, bindUsage);
  const workspace = useService(services, bindWorkspace);
  const threadId = useSelectedThreadId(workspace);
  // Keyed by Thread, as the provisional footer remounted with its Thread.
  return <ThreadUsage key={threadId} threadId={threadId} usage={usage} />;
}
