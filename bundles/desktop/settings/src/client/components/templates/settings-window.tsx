import { Button } from 'desktop/ui/button';
import { SidebarProvider } from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import { ArrowLeftIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import {
  SettingsBreadcrumb,
  type SettingsCrumb,
  SettingsSurface,
} from './settings-surface.js';

type SettingsWindowProps = {
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly nav: ReactNode;
  readonly navEmpty: boolean;
  /**
   * The way back to the page above the one showing. Absent when the window is on
   * a section itself, where there is nowhere above to go.
   */
  readonly onBack?: () => void;
  readonly onQueryChange: (query: string) => void;
  readonly query: string;
  readonly sidebarFooter: ReactNode;
  /** The chain from the surface down to the page showing, outermost first. */
  readonly trail: readonly SettingsCrumb[];
};

/**
 * The way back to the page above the one showing, drawn only while there is one
 * above to reach. The nav column's header holds it, flush to the column's
 * edge, and the breadcrumb's row holds it again under the width
 * that hides that column, so the way out is always somewhere on screen.
 */
function BackControl({
  className,
  onBack,
}: {
  readonly className?: string;
  readonly onBack?: () => void;
}) {
  if (onBack === undefined) return null;

  return (
    <Button
      aria-label="Back"
      className={cn('shrink-0 [app-region:no-drag]', className)}
      onClick={onBack}
      size="icon-sm"
      variant="ghost"
    >
      <ArrowLeftIcon />
    </Button>
  );
}

/**
 * The settings window's frame: the shared settings surface under the window's
 * own title bar, matching the main window's bar — a 40px draggable strip whose
 * left inset clears the native traffic lights.
 *
 * The frame is the window's `--sidebar` canvas (ui-redesign, Figma
 * `36:22049`): the bar and the surface's nav sit on it with no fill and no rule
 * of their own, and the surface sets its section on an inset card.
 *
 * The bar is where the window states what it is showing, so the breadcrumb
 * naming the page lives here rather than in the surface below it, and a page
 * nested under a section reaches the one above it through the back control the
 * nav column's header draws; the surface keeps only the page's own content and
 * footer. A real window already has a native frame to close it, so this draws no
 * close control and fills whatever size the user gives it.
 *
 * The bar and the surface are two rows of one grid, so both are drawn inside the
 * sidebar provider this frame owns: the bar's first cell and the surface's nav
 * column are the same width, which lines the breadcrumb up with the content of
 * the card below it.
 */
export function SettingsWindow({
  children,
  footer,
  nav,
  navEmpty,
  onBack,
  onQueryChange,
  query,
  sidebarFooter,
  trail,
}: SettingsWindowProps) {
  return (
    <SidebarProvider
      className="h-svh min-h-0 flex-col overflow-hidden bg-sidebar"
      style={{ '--sidebar-width': '240px' } as CSSProperties}
    >
      <div
        data-slot="settings-title-bar"
        className="relative flex chrome-bar shrink-0 items-center [app-region:drag]"
      >
        {/*
          The nav column's own header. It clears the native traffic lights that
          sit over the column it heads, and carries the way back out of a page
          nested under a section, flush to the column's edge.
        */}
        <div className="hidden h-full w-(--sidebar-width) shrink-0 items-center justify-end md:flex">
          <BackControl onBack={onBack} />
        </div>
        {/*
          The left inset clears the traffic lights whenever the nav column is
          not drawn, as the main window's header does while its sidebar is shut;
          beside the column it is the card's own 16px, so the breadcrumb starts
          where the section's content does.
          The way back rides in the nav column's header, so under the width that
          hides that column it falls back to this side, the only one left.
        */}
        <div className="relative z-10 flex h-full min-w-0 flex-1 items-center gap-1 pr-3 pl-20 md:pl-4">
          <BackControl className="md:hidden" onBack={onBack} />
          <SettingsBreadcrumb trail={trail} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <SettingsSurface
          footer={footer}
          nav={nav}
          navEmpty={navEmpty}
          onQueryChange={onQueryChange}
          query={query}
          sidebarFooter={sidebarFooter}
        >
          {children}
        </SettingsSurface>
      </div>
    </SidebarProvider>
  );
}
