// Where the footer execution picker is drawn in the app, as a story
// decorator: the conversation footer band at the end of the conversation's
// card (ui-redesign; Figma `36:22049`, `32:51299`).

import type { ComponentType } from 'react';

/**
 * The conversation footer band at the end of the conversation's card, with
 * room above it for the pickers' popovers: drawn in flow, 36 px tall, 8 px
 * above its 28 px row, with the card's 8 px padding under it, no rule and no
 * fill. The app's band in `conversation-frame.tsx` is 44 px and carries those
 * 8 px itself on a card with no bottom padding, so the row stands in the same
 * place; it gets its fill from the layout sheet.
 */
export const footerFrame = (Story: ComponentType) => (
  <div className="bg-sidebar p-2">
    <div className="flex min-h-96 flex-col justify-end overflow-hidden rounded-xl bg-background p-2 shadow-sm">
      <footer className="flex h-9 shrink-0 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal text-muted-foreground">
        <Story />
      </footer>
    </div>
  </div>
);
