import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from 'desktop/ui/resizable';
import { cn } from 'desktop/ui/utils';
import { type ReactNode, useLayoutEffect } from 'react';
import { usePanelRef } from 'react-resizable-panels';

import { INSET_CARD } from './inset-card.js';

type WorkspaceLayoutProps = {
  /**
   * The conversation card, drawn by the caller with `INSET_CARD`. The layout
   * places it under `header`, in the conversation column, and gives it S34's
   * margins: `mb-2`, and `mr-2` when it is the last card in the row and no
   * Files column is shown. The layout adds no fill or border of its own.
   */
  readonly children: ReactNode;
  /**
   * The sidebar column, including its 40 px header (`ProjectSidebar` with
   * `header`). It is full height and not collapsible: 280 px by default,
   * between 11rem and 24rem.
   */
  readonly sidebar: ReactNode;
  /**
   * The conversation column's 40 px header: the Project tab bar, which
   * includes its right-end `actions`. It spans the conversation column only.
   */
  readonly header: ReactNode;
  /**
   * The viewer column's 40 px header: the open tabs' triggers, as transparent
   * pill tabs above the viewer card (§2.5, `32:49927`). The header strip is
   * draggable, apart from the triggers. It is drawn only while `fileViewer` is
   * present.
   */
  readonly viewerTabs?: ReactNode;
  /**
   * The open viewer tab's content. Its presence is the viewer's open state: when
   * it is absent, there is no handle, no viewer column and no width to report.
   * When it is present, the layout draws an invisible handle and then the viewer
   * column. The handle is full height, 8 px wide and has no line (S24, G1). The
   * column holds `viewerTabs` above a `<section aria-label="Viewer">` that
   * carries `INSET_CARD` and the S34 margins.
   */
  readonly fileViewer?: ReactNode;
  /**
   * The Files column's panel: the selected `layout.panel` view. Absent when
   * unsupported. The column is full height and collapsible to 0: 328 px by
   * default, between 14rem and 30rem. It is mounted only while `filesOpen` is
   * true; when collapsed it is zero width and mounts nothing.
   */
  readonly files?: ReactNode;
  /**
   * Whether the Files column is expanded. The state is controlled, so a drag
   * that shuts the column and the controls always agree.
   */
  readonly filesOpen?: boolean;
  /** Reports that the Files column opened or closed, from its handle or elsewhere. */
  readonly onFilesOpenChange?: (open: boolean) => void;
};

export function WorkspaceLayout({
  children,
  header,
  viewerTabs,
  files,
  filesOpen = false,
  fileViewer,
  onFilesOpenChange,
  sidebar,
}: WorkspaceLayoutProps) {
  const filesPanel = usePanelRef();
  const viewerOpen = fileViewer !== undefined;
  const filesShown = files !== undefined && filesOpen;

  useLayoutEffect(() => {
    try {
      if (filesOpen) filesPanel.current?.expand();
      else filesPanel.current?.collapse();
    } catch {
      // The group or panel may be unmounting or not registered yet.
    }
  }, [filesOpen, filesPanel]);

  return (
    <div
      data-slot="workspace-layout"
      className="flex h-full min-h-0 flex-1 flex-col bg-sidebar"
    >
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        style={{ overflow: 'visible' }}
      >
        <ResizablePanel
          className="overflow-hidden"
          defaultSize="280px"
          minSize="11rem"
          maxSize="24rem"
        >
          {sidebar}
        </ResizablePanel>
        <ResizableHandle className="bg-transparent [app-region:no-drag]" />
        <ResizablePanel className="min-w-0" minSize="16rem">
          <div className="flex h-full min-h-0 flex-col">
            {header}
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col mb-2',
                !viewerOpen && !filesShown && 'mr-2',
              )}
            >
              {children}
            </div>
          </div>
        </ResizablePanel>
        {viewerOpen && (
          <>
            {/*
            The viewer column exists only while a tab is open, so the handle
            has nothing to disable: closing the last tab unmounts it, and the
            tab's own control is what closes it.
          */}
            <ResizableHandle className="z-10 w-2 bg-transparent [app-region:no-drag]" />
            <ResizablePanel
              className="overflow-hidden"
              defaultSize="34rem"
              minSize="18rem"
              maxSize="60rem"
            >
              <div className="flex h-full min-h-0 flex-col">
                <div
                  data-slot="workspace-viewer-header"
                  className="flex h-10 shrink-0 items-center gap-2 [-webkit-app-region:drag]"
                >
                  {viewerTabs}
                </div>
                <section
                  aria-label="Viewer"
                  className={cn(
                    INSET_CARD,
                    'flex-1',
                    'mb-2',
                    !filesShown && 'mr-2',
                  )}
                >
                  {fileViewer}
                </section>
              </div>
            </ResizablePanel>
          </>
        )}
        {files !== undefined && (
          <>
            <ResizableHandle
              disabled={!filesOpen}
              className={
                filesOpen
                  ? 'bg-transparent [app-region:no-drag]'
                  : 'pointer-events-none w-0! bg-transparent after:hidden [app-region:no-drag]'
              }
            />
            <ResizablePanel
              panelRef={filesPanel}
              className="overflow-hidden"
              collapsible
              collapsedSize={0}
              defaultSize="328px"
              minSize="14rem"
              maxSize="30rem"
              onResize={(size) => onFilesOpenChange?.(size.inPixels > 0)}
            >
              {filesOpen && (
                <div className="flex h-full min-h-0 flex-col">
                  <div
                    data-slot="workspace-files-header"
                    className="flex h-10 shrink-0 items-center [-webkit-app-region:drag]"
                  />
                  {files}
                </div>
              )}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
