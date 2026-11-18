import type { Disposable, Services } from 'bundle/contracts';
import { useMemo } from 'react';
import { type Project, RuntimeRecordsV1, type Thread } from 'runtime/contracts';
import { WorkspaceSelectionV1 } from 'workspace/contracts';

import { useService, useSubscribed } from './use-service.js';

export interface Selection {
  /** False while `workspace` does not serve `workspace.selection/v1`. */
  readonly available: boolean;
  readonly project?: Project;
  readonly thread?: Thread;
}

const none: Selection = { available: false };

/**
 * The workspace's selection with its records, re-read after every change of
 * the selected ids (`workspace.selection/v1`) or of the records
 * (`runtime.records/v1`).
 */
export const useSelection = (services: Services): Selection => {
  const selection = useService(services, WorkspaceSelectionV1);
  const records = useService(services, RuntimeRecordsV1);
  // Both contracts' notifications, as one source.
  const source = useMemo(
    () =>
      selection === undefined
        ? undefined
        : {
            subscribe: (listener: () => void): Disposable => {
              const subscriptions = [
                selection.subscribe(listener),
                ...(records === undefined ? [] : [records.subscribe(listener)]),
              ];
              return {
                dispose: () => {
                  for (const subscription of subscriptions) {
                    subscription.dispose();
                  }
                },
              };
            },
          },
    [selection, records],
  );
  return useSubscribed<Selection>(
    source,
    () => {
      const { projectId, threadId } = (
        selection as NonNullable<typeof selection>
      ).current();
      return selectionOf(
        projectId === undefined ? undefined : records?.project(projectId),
        threadId === undefined ? undefined : records?.thread(threadId),
      );
    },
    none,
  );
};

// `useSyncExternalStore` needs a stable snapshot while nothing changed.
let last: Selection = none;
const selectionOf = (
  project: Project | undefined,
  thread: Thread | undefined,
): Selection => {
  if (last.available && last.project === project && last.thread === thread)
    return last;
  last = {
    available: true,
    ...(project === undefined ? {} : { project }),
    ...(thread === undefined ? {} : { thread }),
  };
  return last;
};
