import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useSidebar } from '@/components/ui/sidebar';
import { type ReactNode, useLayoutEffect } from 'react';
import { usePanelRef } from 'react-resizable-panels';

/**
 * The width the sandbox panel keeps when it is collapsed. It is a rail rather
 * than nothing at all, so the panel's own toggle stays at the window's right
 * corner and can always expand it again; it is wide enough for that toggle plus
 * its margin, which is why it is not narrower.
 */
const FILES_RAIL_PX = 48;

type WorkspaceLayoutProps = {
  readonly children: ReactNode;
  /**
   * The Project's sandbox panel, after the main panel. It is always mounted,
   * because its collapsed rail carries the toggle that expands it again; the
   * panel itself reads nothing while it is collapsed. Absent when unsupported.
   */
  readonly files?: ReactNode;
  /**
   * Whether that panel is expanded. Collapsed, it keeps a narrow rail so its own
   * toggle stays reachable at the window's right corner. Its open state is
   * controlled, so dragging the panel shut and its toggle always agree.
   */
  readonly filesOpen?: boolean;
  /** Reports that the panel was opened or closed, from its handle or elsewhere. */
  readonly onFilesOpenChange?: (open: boolean) => void;
  readonly footer: ReactNode;
  readonly header: ReactNode;
  readonly sidebar: ReactNode;
  readonly sidebarFooter: ReactNode;
  readonly sidebarHeader: ReactNode;
};

export function WorkspaceLayout({
  children,
  files,
  filesOpen = false,
  footer,
  header,
  onFilesOpenChange,
  sidebar,
  sidebarFooter,
  sidebarHeader,
}: WorkspaceLayoutProps) {
  const { open, setOpen } = useSidebar();
  const panel = usePanelRef();
  const filesPanel = usePanelRef();

  useLayoutEffect(() => {
    if (open) panel.current?.expand();
    else panel.current?.collapse();
  }, [open, panel]);

  useLayoutEffect(() => {
    if (filesOpen) filesPanel.current?.expand();
    else filesPanel.current?.collapse();
  }, [filesOpen, filesPanel]);

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
      {files !== undefined && (
        <>
          <ResizableHandle
            disabled={!filesOpen}
            className={
              filesOpen
                ? '[app-region:no-drag]'
                : 'pointer-events-none w-0! bg-transparent after:hidden [app-region:no-drag]'
            }
          />
          <ResizablePanel
            panelRef={filesPanel}
            className="overflow-hidden"
            collapsible
            collapsedSize={`${String(FILES_RAIL_PX)}px`}
            defaultSize="20rem"
            minSize="14rem"
            maxSize="30rem"
            onResize={(size) =>
              onFilesOpenChange?.(size.inPixels > FILES_RAIL_PX)
            }
          >
            <div className="flex h-full min-h-0 flex-col">{files}</div>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
