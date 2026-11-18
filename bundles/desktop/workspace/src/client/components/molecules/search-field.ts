/**
 * The classes of the sidebar search `InputGroup` (Figma "Search Threads"
 * `I269:31402;331:42177`, InputGroup `22:1244`): 36 px high, the
 * `--secondary` fill (#332f29 dark) with no visible border and no shadow; its
 * `Kbd` keys keep their `--muted` fill (#2d2924), 20 px, radius 2, gap 4.
 *
 * `dark:bg-secondary` overrides the group's own `dark:bg-input/30`, which
 * replaced the fill with #2d2924 over the sidebar: the keys' own color, so
 * they lost their box. Two call sites use it: "Search Threads"
 * (project-sidebar.tsx) and the Dashboard sidebar's "Search projects"
 * (dashboard.tsx).
 */
export const SEARCH_FIELD =
  'h-9 border-transparent bg-secondary shadow-none dark:bg-secondary';
