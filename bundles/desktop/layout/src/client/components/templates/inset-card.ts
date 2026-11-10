/**
 * The classes of the sidebar-08 inset card (S34; Figma `99:8042`, described by
 * `82:97015`): 10 px radius (`rounded-xl`), 8 px padding, `shadow-sm`, the
 * `--background` fill and no border. A card is a flex column that clips its
 * content and may shrink below its content's height.
 *
 * Only the card's look is here. Its margins belong to its place in the
 * window, so the layout adds them: `mb-2` always, plus `mr-2` when the card is
 * last in the row and the Files column is not shown (S34). Two call sites use
 * it: the conversation card (`SidebarInset`, workspace-view.tsx) and the
 * viewer card (`<section aria-label="Viewer">`, workspace-layout.tsx).
 */
export const INSET_CARD =
  'flex min-h-0 flex-col overflow-hidden rounded-xl bg-background p-2 shadow-sm';
