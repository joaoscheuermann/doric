import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from 'desktop/ui/resizable';
import { cn } from 'desktop/ui/utils';
import type { ReactNode } from 'react';

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
   * carries `INSET_CARD` and the S34 margins. The column opens 448 px wide,
   * the prototype's viewer card (`99:8508`: a 456 px column with the 8 px
   * handle), and the conversation takes the rest.
   */
  readonly fileViewer?: ReactNode;
  /**
   * The Files column's panel: the selected `layout.panel` view. Absent when
   * unsupported. When it is given, the column is always shown, full height
   * and not collapsible: 328 px by default, between 14rem and 30rem.
   */
  readonly files?: ReactNode;
  /**
   * The Files column's 40 px header (§2.6, `266:21741`), drawn in
   * `div[data-slot="workspace-files-header"]` above `files`. The header strip is
   * draggable; the caller's controls inside it are not. It is drawn whenever
   * the column is: when `files` is present.
   */
  readonly filesHeader?: ReactNode;
  /**
   * The Files column's footer row, drawn in
   * `div[data-slot="workspace-files-footer"]` below `files`: 28 px high with
   * 8 px above and below it, 4 px left and 12 px right padding and a 6 px gap
   * (`layout/WorkspaceFooter` `266:21739` in `99:8035`). It has no border and
   * no fill. It is drawn whenever the column is: when `files` is present.
   */
  readonly filesFooter?: ReactNode;
};

export function WorkspaceLayout({
  children,
  header,
  viewerTabs,
  files,
  filesHeader,
  filesFooter,
  fileViewer,
  sidebar,
}: WorkspaceLayoutProps) {
  const viewerOpen = fileViewer !== undefined;
  const filesShown = files !== undefined;

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
              defaultSize="448px"
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
            <ResizableHandle className="bg-transparent [app-region:no-drag]" />
            <ResizablePanel
              className="overflow-hidden"
              defaultSize="328px"
              minSize="14rem"
              maxSize="30rem"
            >
              <div className="flex h-full min-h-0 flex-col">
                <div
                  data-slot="workspace-files-header"
                  className="flex h-10 shrink-0 items-center gap-2 px-2 [-webkit-app-region:drag]"
                >
                  {filesHeader}
                </div>
                <div className="flex min-h-0 flex-1 flex-col">{files}</div>
                <div
                  data-slot="workspace-files-footer"
                  className="my-2 flex h-7 shrink-0 items-center gap-1.5 pr-3 pl-1"
                >
                  {filesFooter}
                </div>
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
