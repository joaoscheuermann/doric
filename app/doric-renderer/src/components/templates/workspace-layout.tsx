import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useSidebar } from '@/components/ui/sidebar';
import { type ReactNode, useLayoutEffect } from 'react';
import { usePanelRef } from 'react-resizable-panels';

type WorkspaceLayoutProps = {
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly header: ReactNode;
  readonly sidebar: ReactNode;
  readonly sidebarFooter: ReactNode;
  readonly sidebarHeader: ReactNode;
};

export function WorkspaceLayout({
  children,
  footer,
  header,
  sidebar,
  sidebarFooter,
  sidebarHeader,
}: WorkspaceLayoutProps) {
  const { open, setOpen } = useSidebar();
  const panel = usePanelRef();

  useLayoutEffect(() => {
    if (open) panel.current?.expand();
    else panel.current?.collapse();
  }, [open, panel]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel
        panelRef={panel}
        className="overflow-hidden"
        collapsible
        collapsedSize={0}
        defaultSize="15rem"
        minSize="11rem"
        maxSize="24rem"
        onResize={(size) => setOpen(size.asPercentage > 0)}
      >
        <div className="flex h-full min-h-0 flex-col">
          {open && sidebarHeader}
          <div className="min-h-0 flex-1">{sidebar}</div>
          {open && sidebarFooter}
        </div>
      </ResizablePanel>
      <ResizableHandle
        withHandle={open}
        disabled={!open}
        className={
          open
            ? '[app-region:no-drag]'
            : 'pointer-events-none w-0! bg-transparent after:hidden [app-region:no-drag]'
        }
      />
      <ResizablePanel className="min-w-0">
        <div className="flex h-full min-h-0 flex-col">
          {header}
          {children}
          {footer}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
