import {
  isTerminal,
  type Project,
  type Thread,
} from '../../contracts/model.js';
import type { ProjectActivity } from '../../contracts/runtime.js';

/** Summarizes stored records without changing their timestamps. */
export const summarizeActivity = (
  project: Project,
  threads: readonly Thread[],
): ProjectActivity => {
  const latest = threads
    .filter((thread) => !isTerminal(thread.state))
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    )[0];
  const activityAt = threads.reduce(
    (date, thread) => (thread.updatedAt > date ? thread.updatedAt : date),
    project.updatedAt,
  );
  return {
    project,
    activityAt,
    ...(latest === undefined ? {} : { latestActiveThreadId: latest.id }),
  };
};

export const sortActivity = (
  items: readonly ProjectActivity[],
): readonly ProjectActivity[] =>
  [...items].sort(
    (left, right) =>
      right.activityAt.localeCompare(left.activityAt) ||
      left.project.id.localeCompare(right.project.id),
  );
