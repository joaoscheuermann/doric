/**
 * Presentation for a nested tree row: the depth guides plus the shared
 * indentation, sub-list and interaction classes the tree rows use.
 */
/** One tree level's indent: 20 px, so a child's lead clears its parent's. */
const treeStep = 1.25;

/** The shared class for the nested `SidebarMenuSub` that holds a tree level. */
export const treeClassName =
  'mx-0 w-full min-w-0 translate-x-0 gap-0 overflow-hidden border-0 px-0 py-0';

/**
 * Left padding for a row at `depth`, shared by tree rows and draft rows: 6 px
 * plus 20 px per level.
 */
export const indentation = (depth: number): string =>
  `${0.375 + depth * treeStep}rem`;

/** Row interaction classes: a selected row keeps its hover accent. */
export const rowInteraction = (selected: boolean): string =>
  selected
    ? 'hover:bg-sidebar-accent active:bg-sidebar-accent'
    : 'hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground';

/** A level's guide runs through the centre of its parent's 16 px lead slot. */
const guidePosition = (level: number): string =>
  `${0.875 + level * treeStep}rem`;

/** The vertical connector lines that mark a nested row's depth. */
export function TreeGuides({ depth }: { readonly depth: number }) {
  if (depth === 0) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {Array.from({ length: depth }, (_, level) => guidePosition(level)).map(
        (left) => (
          <span
            key={left}
            className="absolute inset-y-0 w-px bg-sidebar-border"
            style={{ left }}
          />
        ),
      )}
    </span>
  );
}
