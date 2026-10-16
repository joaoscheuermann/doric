// The frame a panel story draws in: the panel column's sidebar, at the width
// the workspace gives the Files and Changes panels, around a `SidebarMenu`
// tree, as `bundles/features/files` mounts the shared `FileTree`.

import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarProvider,
} from 'desktop/ui/sidebar';
import type { ReactNode } from 'react';

export function PanelFrame({
  children,
  tree = false,
}: {
  readonly children: ReactNode;
  /** Wraps the children in the `role="tree"` menu a file tree hangs from. */
  readonly tree?: boolean;
}) {
  return (
    <SidebarProvider className="min-h-0 w-fit">
      <Sidebar collapsible="none" className="h-[28rem] w-72 rounded-lg border">
        <SidebarContent className="p-0">
          {tree ? (
            <SidebarMenu role="tree" className="w-full gap-0 py-1">
              {children}
            </SidebarMenu>
          ) : (
            children
          )}
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
}
