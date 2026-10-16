// The conversation's footer bar, where `<usage-summary>` sits in the
// `layout.footer` region: a chrome bar at the bottom of the chat column,
// with room above it for the popovers that open upward.

import type { ComponentType } from 'react';

export const footerDecorator = (Story: ComponentType) => (
  <div className="mx-auto flex min-h-96 max-w-3xl flex-col justify-end">
    <footer className="flex chrome-bar shrink-0 items-center justify-end gap-1 border-t px-2 text-[11px] font-light text-muted-foreground">
      <Story />
    </footer>
  </div>
);

/** A popover's frame, for parts the footer draws inside one. */
export const popoverDecorator = (Story: ComponentType) => (
  <div className="w-60 overflow-hidden rounded-md border border-border bg-background pt-2.5 text-xs font-normal text-foreground">
    <Story />
  </div>
);
