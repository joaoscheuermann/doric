import { Button } from 'desktop/ui/button';
import { HouseIcon } from 'lucide-react';

export type SidebarHeaderProps = {
  /**
   * Opens the Dashboard. The workspace view passes its tab navigation with
   * `/projects`, the call the Home tab made (`project-tabs.tsx:292`).
   */
  readonly onDashboard: () => void;
};

/**
 * The sidebar column's 40 px header (§2.2, Figma `256:20963`). On the left it
 * leaves room for the macOS window controls, then draws the Dashboard button:
 * lucide `HouseIcon`, ghost `icon-sm`, accessible name "Dashboard".
 *
 * - The header is a window drag region; its buttons are not.
 * - It draws nothing on its right side (S29); 4.2 and 4.3 add Back/Forward and
 *   Search there.
 * - Pressing the button calls `onDashboard` once.
 * - It renders `div[data-slot="workspace-sidebar-header"]`. That slot was
 *   freed by the deleted `WorkspaceSidebarHeader`; `sidebar-header` is
 *   `desktop/ui/sidebar`'s own slot (`sidebar.tsx:354`).
 */
export function SidebarHeader({ onDashboard }: SidebarHeaderProps) {
  const mac = navigator.userAgent.includes('Mac');
  return (
    <div
      data-slot="workspace-sidebar-header"
      className={`flex h-10 shrink-0 items-center gap-1 pr-2 [-webkit-app-region:drag] ${mac ? 'pl-[var(--doric-safe-left,80px)]' : 'pl-2'}`}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dashboard"
        title="Dashboard"
        className="[-webkit-app-region:no-drag]"
        onClick={() => onDashboard()}
      >
        <HouseIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}
