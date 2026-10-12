import { moveItem } from '../utility/move-item.js';

/**
 * The order the "Project views" strip draws its views in: the reader's order
 * for the views it already holds, then each new view in the order it was
 * given (region order). A view that left the panel leaves the order.
 */
export const panelOrder = (
  current: readonly string[],
  available: readonly string[],
): readonly string[] => {
  const kept = current.filter((id) => available.includes(id));
  const added = available.filter((id) => !kept.includes(id));
  if (added.length === 0 && kept.length === current.length) return current;
  return [...kept, ...added];
};

/** The order after the reader dragged `from` onto `to`. */
export const movedPanelOrder = (
  current: readonly string[],
  from: string,
  to: string,
): readonly string[] =>
  moveItem(current, current.indexOf(from), current.indexOf(to));
