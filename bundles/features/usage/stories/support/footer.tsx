// The conversation's footer band, where `<usage-summary>` sits in the
// `layout.footer` region: a borderless 28 px band at the bottom of the
// conversation's inset card over the window's sidebar-coloured canvas, with
// room above it for the popovers that open upward.

import type { ComponentType } from 'react';

export const footerDecorator = (Story: ComponentType) => (
  <div className="mx-auto flex max-w-3xl flex-col bg-sidebar p-2">
    <div className="flex min-h-96 flex-col justify-end overflow-hidden rounded-xl bg-background shadow-sm">
      <footer className="flex h-7 shrink-0 items-center justify-end gap-1 pl-2 text-[11px] font-normal text-muted-foreground">
        <Story />
      </footer>
    </div>
  </div>
);

/** A popover's frame, for parts the footer draws inside one. */
export const popoverDecorator = (Story: ComponentType) => (
  <div className="w-60 overflow-hidden rounded-md border border-border bg-background pt-2.5 text-xs font-normal text-foreground">
    <Story />
  </div>
);
