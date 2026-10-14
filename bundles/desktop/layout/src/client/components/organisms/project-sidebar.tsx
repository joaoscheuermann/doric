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
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from 'desktop/ui/sidebar';
import { AlertCircleIcon, PlusIcon } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';

import { threadIconKind } from '../../domain/sidebar.js';
import { showsSidebarRegion } from '../../domain/sidebar-stack.js';
import { threadLevel } from '../../domain/thread-tree.js';
import type {
  Draft,
  Entity,
  Project,
  ProjectColor,
  Thread,
} from '../../domain/workspace.js';
import { useRegionItems } from '../../hooks/use-region-items.js';
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

/**
 * The region the stack draws as its second group. It belongs to the layout
 * (stage 9 §5.4) and is contributed by whichever bundle wants a group of its
 * own under the Threads tree.
 */
const SIDEBAR_REGION = 'layout.sidebar';

type ProjectSidebarProps = {
  readonly actions: SidebarActions;
  readonly model: SidebarModel;
  /** The `layout.sidebar` region, below the tree (stage 9 §5.4). */
  readonly after?: ReactNode;
};

export function ProjectSidebar({ after, actions, model }: ProjectSidebarProps) {
  // Threads start open; selection never closes another branch.
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(
    new Set(),
  );
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

  // The stack's second group is the `layout.sidebar` region: it shows the items
  // other bundles registered there. Like the files panel, it stays in its group
  // and is collapsed rather than unmounted while the region has none, so an
  // empty region leaves the Threads group the whole sidebar and the handle
  // between them inert — the sidebar as it was before the stack existed.
  const regionItems = useRegionItems(SIDEBAR_REGION);
  const regionOpen = showsSidebarRegion(regionItems);
  const regionPanel = usePanelRef();
  useLayoutEffect(() => {
    if (regionOpen) regionPanel.current?.expand();
    else regionPanel.current?.collapse();
  }, [regionOpen, regionPanel]);

  return (
    <Sidebar collapsible="none" className="overflow-hidden font-normal">
      <SidebarContent className="overflow-hidden p-0">
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel className="no-scrollbar" minSize="20%">
            <SidebarGroup className="p-0">
              <div className="group/group-label relative">
                <SidebarGroupLabel className="h-7 rounded-none px-3 text-xs font-normal">
                  Threads
                </SidebarGroupLabel>
                <SidebarGroupAction
                  className="pointer-events-none top-1 right-1 opacity-0 group-hover/group-label:pointer-events-auto group-hover/group-label:opacity-100 group-focus-within/group-label:pointer-events-auto group-focus-within/group-label:opacity-100"
                  aria-label="New thread"
                  disabled={projectId === undefined}
                  onClick={() => {
                    if (projectId !== undefined) actions.beginThread(projectId);
                  }}
                >
                  <PlusIcon />
                </SidebarGroupAction>
              </div>
              <SidebarGroupContent className="w-full">
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
                        <SidebarMenuSkeleton showIcon />
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
                      icon={threadIconKind}
                      level={threadLevel(threads, model.draft, projectId)}
                      onExpand={expandThread}
                      onToggle={toggleThread}
                      selectedThreadId={model.selectedThreadId}
                    />
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </ResizablePanel>
          {/*
            The divider between the two groups: dragging it is what resizes
            them. An empty region has nothing under it, so the handle is
            disabled and zero-sized — `h-0!` zeroes this stack's axis, where
            the files panel's `w-0!` zeroes the horizontal one.
          */}
          <ResizableHandle
            disabled={!regionOpen}
            className={
              regionOpen
                ? ''
                : 'pointer-events-none w-0! h-0! bg-transparent after:hidden'
            }
          />
          <ResizablePanel
            panelRef={regionPanel}
            className="no-scrollbar"
            collapsible
            collapsedSize={0}
            defaultSize="40%"
            minSize="20%"
            maxSize="80%"
          >
            {after}
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarContent>
    </Sidebar>
  );
}
