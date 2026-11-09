import { Alert, AlertDescription, AlertTitle } from 'desktop/ui/alert';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from 'desktop/ui/resizable';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import { AlertCircleIcon, ChevronRightIcon, PlusIcon } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';

import type { StackPane } from '../../../contracts/index.js';
import { threadIconKind } from '../../domain/sidebar.js';
import {
  PANE_HEADER,
  paneExpanded,
  THREADS_PANE_ID,
} from '../../domain/sidebar-stack.js';
import { threadLevel } from '../../domain/thread-tree.js';
import type {
  Draft,
  Entity,
  Project,
  ProjectColor,
  Thread,
} from '../../domain/workspace.js';
import { usePaneOpen, useStackPanes } from '../../hooks/use-stack-panes.js';
import { setPaneOpen, togglePane } from '../../stores/stack.js';
import { ElementHost } from '../molecules/element-host.js';
import {
  ThreadBranches,
  type ThreadBranchesActions,
} from '../molecules/thread-branches.js';

/** Placeholder thread rows while the selected project's tree loads. */
const THREAD_SKELETON_ROWS = Array.from(
  { length: 3 },
  (_, row) => `thread-skeleton-${row}`,
);

export type SidebarModel = {
  readonly draft?: Draft;
  readonly editing?: Entity;
  readonly error?: string;
  readonly loadingProjectThreads: ReadonlySet<string>;
  readonly loadingProjects: boolean;
  readonly projects: readonly Project[];
  readonly selectedProjectId?: string;
  readonly selectedThreadId?: string;
  readonly threadsByProject: Readonly<Record<string, readonly Thread[]>>;
};

export type SidebarActions = {
  readonly beginProject: () => void;
  readonly beginThread: (projectId: string, parentThreadId?: string) => void;
  readonly cancelDraft: () => void;
  readonly cancelRename: () => void;
  readonly copyThreadId: (id: string) => void;
  readonly createProject: (name: string) => Promise<void>;
  readonly createThread: (name: string) => Promise<void>;
  readonly deleteEntity: (entity: Entity) => void;
  readonly rename: (entity: Entity, name: string) => Promise<void>;
  readonly selectProject: (project: Project) => void;
  readonly selectThread: (thread: Thread) => void;
  readonly setProjectColor: (project: Project, color?: ProjectColor) => void;
  readonly startRename: (entity: Entity) => void;
};

type ProjectSidebarProps = {
  readonly actions: SidebarActions;
  /**
   * The column's 40 px header (`SidebarHeader`), drawn above the panes as the
   * first child of the `<Sidebar collapsible="none">` (`:291`), outside the
   * panes' vertical resizable group. Absent: the panes start at the top.
   */
  readonly header?: ReactNode;
  readonly model: SidebarModel;
};

/**
 * One group of the sidebar's stack (`layout.stack/v1`): the panel, the divider
 * after it, and the header the layout draws — the pane's title, its collapse
 * control and its own action element. A collapsed pane keeps its header, so no
 * resize of the stack can make the group vanish; the panel's open state is the
 * stack's, and a drag that reaches the header reports it collapsed.
 */
function PanePanel({
  action,
  children,
  pane,
}: {
  readonly action?: ReactNode;
  readonly children?: ReactNode;
  readonly pane: StackPane;
}) {
  const open = usePaneOpen(pane.id);
  const panel = usePanelRef();
  const header = useRef<HTMLDivElement>(null);
  const collapsible = pane.collapsible !== false;

  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const target = panel.current;
    if (target === null || !collapsible) return;

    try {
      if (open) target.expand();
      else target.collapse();
    } catch {
      // The group or panel may be unmounting or not registered yet.
    }
  }, [collapsible, open, panel]);

  return (
    <ResizablePanel
      panelRef={panel}
      className="no-scrollbar"
      collapsible={collapsible}
      collapsedSize={PANE_HEADER}
      defaultSize={open ? pane.defaultSize : PANE_HEADER}
      maxSize={pane.maxSize ?? '100%'}
      minSize={pane.minSize ?? '20%'}
      onResize={
        collapsible
          ? (size) => {
              const headerPixels = header.current?.offsetHeight ?? 0;
              if (headerPixels === 0) return;

              setPaneOpen(pane.id, paneExpanded(size.inPixels, headerPixels));
            }
          : undefined
      }
    >
      <SidebarGroup className="flex h-full min-h-0 flex-col p-0">
        <div ref={header} className="relative">
          <SidebarGroupLabel className="h-7 gap-1 rounded-none pl-3 pr-8 text-xs font-normal [&_svg]:size-4 [&_svg]:shrink-0">
            {collapsible ? (
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${pane.title}`}
                className="flex min-w-0 flex-1 items-center gap-1 text-left outline-hidden focus-visible:ring-2"
                onClick={() => togglePane(pane.id)}
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    'size-4 shrink-0 transition-transform duration-[50ms] ease-out',
                    open ? 'rotate-90' : 'rotate-0',
                  )}
                />
                <span className="truncate">{pane.title}</span>
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate">{pane.title}</span>
            )}
          </SidebarGroupLabel>
          {action}
        </div>
        {open && (
          <SidebarGroupContent className="min-h-0 w-full flex-1 overflow-y-auto">
            {pane.tag === undefined ? (
              (children ?? null)
            ) : (
              <ElementHost
                tag={pane.tag}
                {...(pane.props === undefined ? {} : { props: pane.props })}
              />
            )}
          </SidebarGroupContent>
        )}
      </SidebarGroup>
    </ResizablePanel>
  );
}

/**
 * The "+ New Thread" row (§2.2; drawn as the prototype's `Button · New thread`
 * in `269:31402`, a 28 px small button with a 14 px plus, which wins over the
 * component frame `110:23119`, UR1): a full-width sidebar menu button with
 * lucide `PlusIcon` and the text "New Thread", 8 px above the Threads label.
 * Pressing it calls `actions.beginThread(projectId)` once. That is the inline
 * root draft the Threads pane's "+" started before, and it shows as the "New
 * thread name" field at the end of the tree.
 *
 * - Accessible name: "New Thread" (its text). It is a `button`
 *   (`SidebarMenuButton`, `data-slot="sidebar-menu-button"`) inside
 *   `ul[data-slot="sidebar-menu"]`, outside the panes' resizable group, so it
 *   neither collapses nor scrolls with the tree.
 * - With no selected Project (`model.selectedProjectId === undefined`), it
 *   stays visible, carries the `disabled` attribute and does nothing when
 *   pressed. It never calls `beginThread` without a Project id.
 * - It is drawn once, whatever panes the stack holds.
 */
function NewThreadRow({ onBegin }: { readonly onBegin?: () => void }) {
  return (
    <SidebarMenu className="mb-2 px-2 pt-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          className="h-7 gap-1.5 rounded-md px-2.5 text-[0.8rem] font-normal [&_svg]:size-3.5"
          disabled={onBegin === undefined}
          onClick={onBegin}
        >
          <PlusIcon />
          <span>New Thread</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function ProjectSidebar({
  actions,
  header,
  model,
}: ProjectSidebarProps) {
  // Threads start open; selection never closes another branch.
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const panes = useStackPanes();
  const projectId = model.selectedProjectId;
  const threads = projectId ? (model.threadsByProject[projectId] ?? []) : [];
  const loading =
    projectId !== undefined &&
    model.loadingProjectThreads.has(projectId) &&
    threads.length === 0;
  const expandThread = (id: string) =>
    setCollapsedThreads((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  const toggleThread = (id: string) =>
    setCollapsedThreads((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const threadActions: ThreadBranchesActions = {
    beginChild: (thread) => actions.beginThread(thread.projectId, thread.id),
    cancelDraft: actions.cancelDraft,
    cancelRename: actions.cancelRename,
    copyId: actions.copyThreadId,
    create: actions.createThread,
    delete: (thread) => actions.deleteEntity({ kind: 'thread', value: thread }),
    rename: (thread, name) =>
      actions.rename({ kind: 'thread', value: thread }, name),
    select: actions.selectThread,
    startRename: (thread) =>
      actions.startRename({ kind: 'thread', value: thread }),
  };

  // The Threads pane is the layout's own: its rows are this tree, and the New
  // Thread row above the stack creates a Thread of the selected Project. Every
  // other pane names the element that draws its content and the one that draws
  // its header action.
  const threadsContent = (
    <>
      {model.error && (
        <Alert variant="destructive" className="mx-2 mb-2 w-auto">
          <AlertCircleIcon />
          <AlertTitle>Unable to update</AlertTitle>
          <AlertDescription>{model.error}</AlertDescription>
        </Alert>
      )}
      <SidebarMenu className="w-full gap-0">
        {loading &&
          THREAD_SKELETON_ROWS.map((row) => (
            <SidebarMenuItem key={row}>
              <SidebarMenuSkeleton
                showIcon
                className="h-7 rounded-none pl-3 pr-8"
              />
            </SidebarMenuItem>
          ))}
        {projectId !== undefined && (
          <ThreadBranches
            actions={threadActions}
            collapsed={collapsedThreads}
            depth={0}
            editingThreadId={
              model.editing?.kind === 'thread'
                ? model.editing.value.id
                : undefined
            }
            repo={threadIconKind}
            level={threadLevel(threads, model.draft, projectId)}
            onExpand={expandThread}
            onToggle={toggleThread}
            selectedThreadId={model.selectedThreadId}
          />
        )}
      </SidebarMenu>
    </>
  );

  const paneAction = (pane: StackPane): ReactNode =>
    pane.id === THREADS_PANE_ID || pane.headerTag === undefined ? null : (
      <ElementHost tag={pane.headerTag} />
    );

  return (
    <Sidebar collapsible="none" className="overflow-hidden font-normal">
      {header}
      <SidebarContent className="overflow-hidden p-0">
        <NewThreadRow
          onBegin={
            projectId === undefined
              ? undefined
              : () => actions.beginThread(projectId)
          }
        />
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          {panes.map((pane, index) => (
            <Fragment key={pane.id}>
              {index > 0 && <ResizableHandle />}
              <PanePanel action={paneAction(pane)} pane={pane}>
                {pane.id === THREADS_PANE_ID ? threadsContent : undefined}
              </PanePanel>
            </Fragment>
          ))}
        </ResizablePanelGroup>
      </SidebarContent>
    </Sidebar>
  );
}
