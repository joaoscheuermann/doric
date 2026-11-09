// The window's inset-card look for the terminal stories (ui-redesign S34;
// Figma `40:29146`, `5:23`): the `--sidebar` canvas, and on it the viewer's
// card — 10 px radius, 8 px padding, `shadow-sm`, the `--background` fill, no
// border — as the layout draws a terminal tab.

import type { ReactNode } from 'react';

/** A terminal tab's frame: the viewer card over the window's canvas. */
export function InsetCard({
  children,
  height,
}: {
  readonly children: ReactNode;
  readonly height: number;
}) {
  return (
    <div className="flex flex-col bg-sidebar p-2" style={{ height }}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-background p-2 shadow-sm">
        {children}
      </div>
    </div>
  );
}
