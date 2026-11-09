import type { ThreadNode } from './thread-tree.js';

/**
 * What the Project sidebar's "Search Threads" query leaves of the Thread tree
 * (§4.3): the Threads drawn and, among them, the ones drawn expanded.
 */
export type ThreadFilter = {
  /** The matching Threads and every ancestor of a match. */
  readonly shown: ReadonlySet<string>;
  /** The ancestors of a match: drawn expanded whatever the collapsed set holds. */
  readonly expanded: ReadonlySet<string>;
};

/**
 * Filters a project's Thread tree by `query`: a Thread matches when the name
 * its row shows, `thread.name || 'Untitled'`, contains `query`, case-
 * insensitively, so "untitled" finds the Threads without a name. Pure; walks
 * `nodes` and their children. An empty query matches every Thread; the
 * sidebar does not filter while its query is empty.
 */
export const filterThreadTree = (
  nodes: readonly ThreadNode[],
  query: string,
): ThreadFilter => {
  const needle = query.toLowerCase();
  const shown = new Set<string>();
  const expanded = new Set<string>();
  // Answers whether the node or one of its descendants matches.
  const visit = (node: ThreadNode): boolean => {
    const { id, name } = node.thread;
    let below = false;
    for (const child of node.children.nodes) below = visit(child) || below;
    if (below) expanded.add(id);
    const keep = below || (name || 'Untitled').toLowerCase().includes(needle);
    if (keep) shown.add(id);
    return keep;
  };
  for (const node of nodes) visit(node);
  return { shown, expanded };
};
