// The window's inset-card look for the chat stories (ui-redesign S34; Figma
// `99:8042`): the `--sidebar` canvas, and on it the content card — 10 px
// radius, 8 px padding, `shadow-sm`, the `--background` fill, no border — as
// the layout draws the conversation and the viewer. The footer band is the
// app's band drawn in flow (`chat-view.tsx`, the layout's
// `conversation-frame.tsx`; Figma `32:51299`), since these stories have no
// conversation to float over: 36 px tall, 8 px above its 28 px row, 8 px from
// the left, 4 px between items, no rule, with the card's 8 px padding under
// it. The app's band is 44 px and carries those 8 px itself on a card with no
// bottom padding; the row stands in the same place.

import type { ReactNode } from 'react';

/** The card on its canvas; `className` sizes the card. */
export function InsetCard({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className="bg-sidebar p-2">
      <div
        className={`flex min-h-0 flex-col overflow-hidden rounded-xl bg-background p-2 shadow-sm ${className ?? ''}`}
      >
        {children}
      </div>
    </div>
  );
}

/** The conversation footer band, at the end of a card. */
export function FooterBand({ children }: { readonly children: ReactNode }) {
  return (
    <footer className="flex h-9 shrink-0 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal">
      {children}
    </footer>
  );
}
