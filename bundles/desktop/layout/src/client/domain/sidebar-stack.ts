// The sidebar's vertical stack: the Threads group, the `layout.sidebar`
// region's own group below it, and the drag handle between them
// (`organisms/project-sidebar.tsx`). The stack is geometry that only the
// running window can prove; the one rule that decides whether the region has a
// group at all is stated here, without React, and tested.

/**
 * Whether the sidebar's stack draws the `layout.sidebar` region's own group.
 *
 * The region's items are what that group shows, and they belong to other
 * bundles. With none registered the group has nothing to draw, so the Threads
 * group keeps the whole sidebar and the handle between them stays inert — the
 * sidebar as it was before the stack existed.
 */
export const showsSidebarRegion = (regionItems: readonly unknown[]): boolean =>
  regionItems.length > 0;
