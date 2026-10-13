import { Alert, AlertDescription, AlertTitle } from 'desktop/ui/alert';
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
import { type ReactNode, useState } from 'react';

import { threadIconKind } from '../../domain/sidebar.js';
import { threadLevel } from '../../domain/thread-tree.js';
import type {
  Draft,
  Entity,
  Project,
  ProjectColor,
  Thread,
} from '../../domain/workspace.js';
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

  return (
    <Sidebar collapsible="none" className="overflow-hidden font-normal">
      <SidebarContent className="p-0">
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
        {after}
      </SidebarContent>
    </Sidebar>
  );
}
