import type { DoricTheme } from 'bundle/contracts';
import { tokens } from 'desktop/ui/tokens';
import type { CSSProperties } from 'react';

type Variant = 'dark' | 'light';

/**
 * One theme's swatch (`65:13174`): the sidebar's bars on the `--sidebar`
 * canvas beside an inset card with a title bar, two lines and a primary pill.
 * Its colors are pinned to `variant` (G10): the window's token sheet has no
 * light scope inside a dark window, so the half sets its variant's variables
 * itself.
 */
function Half({ variant }: { readonly variant: Variant }) {
  return (
    <div
      data-variant={variant}
      className="flex h-full min-w-0 flex-1 overflow-hidden bg-sidebar py-1.5 pr-1.5"
      style={tokens.variants[variant] as CSSProperties}
    >
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-2.5 pb-2">
        <div className="h-2 w-10 rounded-full bg-sidebar-accent" />
        <div className="h-1 w-8 rounded-full bg-sidebar-foreground/30" />
        <div className="h-1 w-9 rounded-full bg-sidebar-foreground/30" />
        <div className="h-1 w-7 rounded-full bg-sidebar-foreground/30" />
      </div>
      <div className="flex h-full min-w-0 flex-1 flex-col gap-1.5 overflow-hidden rounded-md bg-background p-2.5 shadow-sm">
        <div className="h-1.5 w-12 shrink-0 rounded-full bg-foreground" />
        <div className="h-1.5 w-full shrink-0 rounded-full bg-muted" />
        <div className="h-1.5 w-[70px] shrink-0 rounded-full bg-muted" />
        <div className="flex w-full justify-end">
          <div className="h-3 w-[30px] rounded-full bg-primary" />
        </div>
      </div>
    </div>
  );
}

/** A live swatch of `theme`, 80 tall; System draws Dark and Light halves. */
export function ThemePreview({ theme }: { readonly theme: DoricTheme }) {
  return (
    <div aria-hidden className="flex h-20 w-full overflow-hidden">
      {theme !== 'light' && <Half variant="dark" />}
      {theme !== 'dark' && <Half variant="light" />}
    </div>
  );
}
