import type * as React from 'react';

import { cn } from './lib/utils.js';

export interface ChromeBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Keeps the window's safe area (the macOS window buttons) clear at the bar's
   * leading edge. On by default; a bar that does not start at the window's
   * leading edge turns it off.
   */
  readonly inset?: boolean;
}

/**
 * A window's chrome bar: the draggable strip, `--doric-titlebar-height` tall,
 * that the window's title area is made of. Controls inside it that must stay
 * clickable opt out of dragging with `[app-region:no-drag]`.
 */
export function ChromeBar({
  inset = true,
  className,
  ...props
}: ChromeBarProps): React.JSX.Element {
  return (
    <div
      data-slot="chrome-bar"
      className={cn(
        'chrome-bar flex items-center [app-region:drag]',
        inset && 'ps-(--doric-safe-left)',
        className,
      )}
      {...props}
    />
  );
}
