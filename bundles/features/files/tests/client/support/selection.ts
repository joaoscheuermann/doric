// The window's selection as the files client reads it since bundle isolation
// 4(d): the selected ids from `workspace.selection/v1` and their records from
// `runtime.records/v1` (the records fake of `runtime/testing`, primed so it
// answers the Thread). Spread into a test's `storyServices({ apis })`.

import type { Project, Thread } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';

/** The two providers that select `thread` of `project`. */
export const selectionApis = (
  project: Project,
  thread: Thread,
): Readonly<Record<string, unknown>> => {
  const ids = { projectId: project.id, threadId: thread.id };
  const records = createRecordsApi({ projects: [project], threads: [thread] });
  // The records answer a Thread of a described Project only.
  records.threads(project.id);
  return {
    'workspace.selection/v1': {
      current: () => ids,
      subscribe: () => ({ dispose: () => undefined }),
    },
    'runtime.records/v1': records,
  };
};
