import type { Services } from 'bundle/contracts';
import { LayoutWorkspaceV1 } from 'layout/contracts';
import type { Project, Thread } from 'runtime/contracts';

import { useService, useSubscribed } from './use-service.js';

export interface Selection {
  /** False while the layout does not serve `layout.workspace/v1`. */
  readonly available: boolean;
  readonly project?: Project;
  readonly thread?: Thread;
}

const none: Selection = { available: false };

/** The workspace's validated selection, re-read after every change. */
export const useSelection = (services: Services): Selection => {
  const workspace = useService(services, LayoutWorkspaceV1);
  return useSubscribed<Selection>(
    workspace,
    () => {
      const { project, thread } = (
        workspace as NonNullable<typeof workspace>
      ).selection();
      return selectionOf(project, thread);
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
