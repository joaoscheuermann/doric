import {
  SettingsBreadcrumb,
  type SettingsNavItem,
  SettingsSurface,
} from '@/components/templates/settings-surface';
import { Separator } from '@/components/ui/separator';
import type { ReactNode } from 'react';

type SettingsWindowProps = {
  readonly activeId: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly nav: readonly SettingsNavItem[];
  readonly onSelect: (id: string) => void;
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
 */
export function SettingsWindow({
  activeId,
  children,
  footer,
  nav,
  onSelect,
  title,
}: SettingsWindowProps) {
  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden">
      <div
        data-slot="settings-title-bar"
        className="relative flex h-8 shrink-0 items-center bg-sidebar pl-20 [app-region:drag]"
      >
        <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
        <div className="relative z-10 flex h-full min-w-0 flex-1 items-center px-3">
          <SettingsBreadcrumb title={title} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <SettingsSurface
          activeId={activeId}
          footer={footer}
          nav={nav}
          onSelect={onSelect}
        >
          {children}
        </SettingsSurface>
      </div>
    </div>
  );
}
