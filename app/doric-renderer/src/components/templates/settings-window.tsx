import {
  SettingsBreadcrumb,
  type SettingsCrumb,
  type SettingsNavItem,
  SettingsSurface,
} from '@/components/templates/settings-surface';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarProvider } from '@/components/ui/sidebar';
import { cn } from '@/utility/utils';
import { ArrowLeftIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type SettingsWindowProps = {
  readonly activeId: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly nav: readonly SettingsNavItem[];
  /**
   * The way back to the page above the one showing. Absent when the window is on
   * a section itself, where there is nowhere above to go.
   */
  readonly onBack?: () => void;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (id: string) => void;
  readonly query: string;
  readonly sidebarFooter: ReactNode;
  /** The chain from the surface down to the page showing, outermost first. */
  readonly trail: readonly SettingsCrumb[];
};

/**
 * The way back to the page above the one showing, drawn only while there is one
 * above to reach. The nav column's header holds it, flush to the divider that
 * closes the column, and the breadcrumb's row holds it again under the width
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
 * own title bar, matching the main window's bar — a 32px draggable strip whose
 * left inset clears the native traffic lights, closed by a separator.
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
 * column are the same width, which is what lands the divider in the bar on the
 * separator below it.
 */
export function SettingsWindow({
  activeId,
  children,
  footer,
  nav,
  onBack,
  onQueryChange,
  onSelect,
  query,
  sidebarFooter,
  trail,
}: SettingsWindowProps) {
  return (
    <SidebarProvider className="h-svh min-h-0 flex-col overflow-hidden">
      <div
        data-slot="settings-title-bar"
        className="relative flex h-8 shrink-0 items-center bg-sidebar [app-region:drag]"
      >
        <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
        {/*
          The nav column's own header. It clears the native traffic lights that
          sit over the column it heads, and carries the way back out of a page
          nested under a section, flush to the divider that closes the column.
        */}
        <div className="hidden h-full w-(--sidebar-width) shrink-0 items-center justify-end md:flex">
          <BackControl onBack={onBack} />
        </div>
        <Separator orientation="vertical" className="hidden md:block" />
        {/*
          The left inset clears the traffic lights whenever the nav column is
          not drawn, as the main window's header does while its sidebar is shut.
          The way back rides in the nav column's header, so under the width that
          hides that column it falls back to this side, the only one left.
        */}
        <div className="relative z-10 flex h-full min-w-0 flex-1 items-center gap-1 pr-3 pl-20 md:pl-3">
          <BackControl className="md:hidden" onBack={onBack} />
          <SettingsBreadcrumb trail={trail} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <SettingsSurface
          activeId={activeId}
          footer={footer}
          nav={nav}
          onQueryChange={onQueryChange}
          onSelect={onSelect}
          query={query}
          sidebarFooter={sidebarFooter}
        >
          {children}
        </SettingsSurface>
      </div>
    </SidebarProvider>
  );
}
