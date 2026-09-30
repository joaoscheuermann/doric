import {
  SettingsBreadcrumb,
  type SettingsNavItem,
  SettingsSurface,
} from '@/components/templates/settings-surface';
import { Separator } from '@/components/ui/separator';
import { SidebarProvider } from '@/components/ui/sidebar';
import type { ReactNode } from 'react';

type SettingsWindowProps = {
  readonly activeId: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly nav: readonly SettingsNavItem[];
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (id: string) => void;
  readonly query: string;
  readonly sidebarFooter: ReactNode;
  readonly title: string;
};

/**
 * The settings window's frame: the shared settings surface under the window's
 * own title bar, matching the main window's bar — a 32px draggable strip whose
 * left inset clears the native traffic lights, closed by a separator.
 *
 * The bar is where the window states what it is showing, so the breadcrumb
 * naming the active section lives here rather than in the surface below it; the
 * surface keeps only the section's own content and footer. A real window already
 * has a native frame to close it, so this draws no close control and fills
 * whatever size the user gives it.
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
  onQueryChange,
  onSelect,
  query,
  sidebarFooter,
  title,
}: SettingsWindowProps) {
  return (
    <SidebarProvider className="h-svh min-h-0 flex-col overflow-hidden">
      <div
        data-slot="settings-title-bar"
        className="relative flex h-8 shrink-0 items-center bg-sidebar [app-region:drag]"
      >
        <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
        {/*
          The nav column's own header: empty, because the native traffic lights
          sit over the column it heads, which is the one that clears them.
        */}
        <div className="hidden h-full w-(--sidebar-width) shrink-0 md:flex" />
        <Separator orientation="vertical" className="hidden md:block" />
        {/*
          The left inset clears the traffic lights whenever the nav column is
          not drawn, as the main window's header does while its sidebar is shut.
        */}
        <div className="relative z-10 flex h-full min-w-0 flex-1 items-center pr-3 pl-20 md:pl-3">
          <SettingsBreadcrumb title={title} />
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
