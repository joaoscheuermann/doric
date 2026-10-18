/**
 * The expanded set with `path` added when absent and removed when present. A
 * tree's directories and a collapsed-section set are both kept this way.
 */
export const toggleExpanded = (
  expanded: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> => {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
};
