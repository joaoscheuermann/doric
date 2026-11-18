import { type ProjectTree, threadsOf } from './project-tree.js';
import type { Thread } from './workspace.js';

/** A child opens beside the current root, or beside its own root on a fresh visit. */
export const mainThreadFor = (
  tree: ProjectTree,
  target: Thread,
): Thread | undefined => {
  if (target.parentThreadId === undefined) return target;
  const threads = threadsOf(tree, target.projectId);
  const current = threads.find(
    (thread) => thread.id === tree.selection.threadId,
  );
  if (
    tree.selection.projectId === target.projectId &&
    current !== undefined &&
    current.parentThreadId === undefined
  )
    return current;
  const seen = new Set<string>();
  let ancestor: Thread | undefined = target;
  while (ancestor?.parentThreadId !== undefined) {
    if (seen.has(ancestor.id)) return undefined;
    seen.add(ancestor.id);
    const parent: string = ancestor.parentThreadId;
    ancestor = threads.find((thread) => thread.id === parent);
  }
  return ancestor;
};
