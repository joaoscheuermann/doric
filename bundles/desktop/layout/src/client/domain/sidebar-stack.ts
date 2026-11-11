// The sidebar stack's pure ordering rule (`layout.stack/v2`): the panes bundles
// register, drawn as groups under the Thread region in this order
// (`organisms/project-sidebar.tsx`).

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
