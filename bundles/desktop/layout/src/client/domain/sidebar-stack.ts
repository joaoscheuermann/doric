// The sidebar's vertical stack: the panes bundles register (`layout.stack/v1`)
// and the Threads pane the layout draws itself, behind draggable dividers
// (`organisms/project-sidebar.tsx`). The rules here are pure and tested; the
// geometry itself only the running window can prove.

import type { StackPane } from '../../contracts/index.js';

/**
 * The height a collapsed pane keeps: its own header (`h-7`). It is never zero,
 * so resizing the stack can collapse a pane but never make it vanish — the
 * group keeps its header, its title and its controls on screen, which is the
 * one rule a pane's own geometry depends on.
 */
export const PANE_HEADER = '1.75rem';

/**
 * The Threads tree the layout draws itself, above every registered pane. It
 * carries no `tag`: its rows are the layout's own React tree, not another
 * bundle's element.
 */
export const THREADS_PANE_ID = 'threads';

export const threadsPane: StackPane = {
  id: THREADS_PANE_ID,
  order: 0,
  title: 'Threads',
  collapsible: true,
  minSize: '20%',
};

/**
 * Whether a pane as tall as `pixels` is expanded rather than collapsed to its
 * header. The header's own height is measured, never assumed: the reader may
 * resize it and the workspace may change its font size.
 */
export const paneExpanded = (pixels: number, headerPixels: number): boolean =>
  pixels > headerPixels;

const orderOf = (pane: { readonly order?: number }): number =>
  pane.order ?? Number.POSITIVE_INFINITY;

/**
 * The panes top to bottom: ascending `order`, absent order last, and the
 * registration order within a tie (`Array.prototype.sort` is stable). It is the
 * rule `regions/v1` sorts a region's items by, so a bundle's ordering is the
 * same whether it registers an item or a pane.
 */
export const orderedPanes = <T extends { readonly order?: number }>(
  panes: readonly T[],
): readonly T[] =>
  [...panes].sort((left, right) => orderOf(left) - orderOf(right));
