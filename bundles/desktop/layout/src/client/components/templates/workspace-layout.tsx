import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from 'desktop/ui/resizable';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';

type WorkspaceLayoutProps = {
  readonly children: ReactNode;
  readonly header: ReactNode;
  readonly viewerTabs?: ReactNode;
  readonly headerActions: ReactNode;
  /**
   * The Project's sandbox panel, after the main panel. It is drawn only while
   * that panel is open: closed, it is zero width and mounts nothing. Its controls
   * remain in the Project tab bar. Absent when unsupported.
   */
  readonly files?: ReactNode;
  /**
   * Whether that panel is expanded. Its open state is controlled, so dragging
   * the panel shut and its controls always agree; shut, it reports closed because
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
  readonly sidebar: ReactNode;
};

export function WorkspaceLayout({
  children,
  header,
  viewerTabs,
  headerActions,
  files,
  filesOpen = false,
  fileViewer,
  onFilesOpenChange,
  sidebar,
}: WorkspaceLayoutProps) {
  const filesPanel = usePanelRef();
  const [viewerWidth, setViewerWidth] = useState(0);
  const [filesWidth, setFilesWidth] = useState(0);
  const viewerOpen = fileViewer !== undefined;
  const rightWidth = viewerWidth + (filesOpen ? filesWidth + 1 : 0) + 1;
  const mac = navigator.userAgent.includes('Mac');

  useLayoutEffect(() => {
    if (filesOpen) filesPanel.current?.expand();
    else filesPanel.current?.collapse();
  }, [filesOpen, filesPanel]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 bg-[var(--paper-panel)]">
        <div className="min-w-0 flex-1">{header}</div>
        <div
          data-slot="workspace-viewer-header"
          className={`flex min-w-0 items-center gap-2 border-b border-[var(--paper-separator)] px-2 [-webkit-app-region:drag] ${viewerOpen ? 'border-l' : ''} ${mac ? '' : 'pr-[140px]'}`}
          style={viewerOpen ? { width: rightWidth } : undefined}
        >
          {viewerTabs}
          <div className="ml-auto flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
            {headerActions}
          </div>
        </div>
      </div>
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        style={{ overflow: 'visible' }}
      >
        <ResizablePanel
          className="overflow-hidden"
          defaultSize="240px"
          minSize="11rem"
          maxSize="24rem"
        >
          {sidebar}
        </ResizablePanel>
        <ResizableHandle className="[app-region:no-drag]" />
        <ResizablePanel className="min-w-0" minSize="16rem">
          <div className="flex h-full min-h-0 flex-col">{children}</div>
        </ResizablePanel>
        {fileViewer !== undefined && (
          <>
            {/*
            The division exists only while a file is open, so the handle has
            nothing to disable: closing the file unmounts it, and the file's own
            control is what closes it.
          */}
            <ResizableHandle className="z-10 -mt-10 [app-region:no-drag]" />
            <ResizablePanel
              className="overflow-hidden"
              defaultSize="34rem"
              minSize="18rem"
              maxSize="60rem"
              onResize={(size) => setViewerWidth(size.inPixels)}
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
              onResize={(size) => {
                setFilesWidth(size.inPixels);
                onFilesOpenChange?.(size.inPixels > 0);
              }}
            >
              {filesOpen && (
                <div className="flex h-full min-h-0 flex-col">{files}</div>
              )}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
