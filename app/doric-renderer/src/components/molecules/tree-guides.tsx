/**
 * Presentation for a nested tree row: the depth guides plus the shared
 * indentation, sub-list and interaction classes the tree rows use.
 */
const treeStep = 1.5;

/** The shared class for the nested `SidebarMenuSub` that holds a tree level. */
export const treeClassName =
  'mx-0 w-full translate-x-0 gap-0 border-0 px-0 py-0';

/** Left padding for a row at `depth`, shared by tree rows and draft rows. */
export const indentation = (depth: number): string =>
  `${0.75 + depth * treeStep}rem`;

/** Row interaction classes: a selected row keeps its hover accent. */
export const rowInteraction = (selected: boolean): string =>
  selected
    ? 'hover:bg-sidebar-accent active:bg-sidebar-accent'
    : 'hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground';

const guidePosition = (level: number): string =>
  `${1.1875 + level * treeStep}rem`;

/** The vertical connector lines that mark a nested row's depth. */
export function TreeGuides({ depth }: { readonly depth: number }) {
  if (depth === 0) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="absolute inset-y-0 w-px bg-sidebar-border"
          style={{ left: guidePosition(level) }}
        />
      ))}
    </span>
  );
}
