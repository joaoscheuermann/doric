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
  /**
   * The Project's sandbox panel, after the main panel. It is drawn only while
   * that panel is open: closed, it is zero width and mounts nothing, so the main
   * header is where the control that reopens it lives. Absent when unsupported.
   */
  readonly files?: ReactNode;
  /**
   * Whether that panel is expanded. Its open state is controlled, so dragging
   * the panel shut and its toggle always agree; shut, it reports closed because
   * its width is zero.
   */
  readonly filesOpen?: boolean;
  /**
   * The open file, as a division of its own between the main panel and the
   * sandbox panel. It is mounted only while a file is open, so its presence here
   * is its open state: no file, no division, and no width to report.
   */
  readonly fileViewer?: ReactNode;
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
  fileViewer,
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
      {fileViewer !== undefined && (
        <>
          {/*
            The division exists only while a file is open, so the handle has
            nothing to disable: closing the file unmounts it, and the file's own
            control is what closes it.
          */}
          <ResizableHandle className="[app-region:no-drag]" />
          <ResizablePanel
            className="overflow-hidden"
            defaultSize="34rem"
            minSize="18rem"
            maxSize="60rem"
          >
            <div className="flex h-full min-h-0 flex-col">{fileViewer}</div>
          </ResizablePanel>
        </>
      )}
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
            collapsedSize={0}
            defaultSize="20rem"
            minSize="14rem"
            maxSize="30rem"
            onResize={(size) => onFilesOpenChange?.(size.inPixels > 0)}
          >
            {filesOpen && (
              <div className="flex h-full min-h-0 flex-col">{files}</div>
            )}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
