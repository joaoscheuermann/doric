import { DraftName } from '@/components/molecules/draft-name';
import { EditableName } from '@/components/molecules/editable-name';
import { ItemContextMenu } from '@/components/molecules/item-context-menu';
import { RowAddAction } from '@/components/molecules/row-add-action';
import {
  ThreadBranches,
  type ThreadBranchesActions,
} from '@/components/molecules/thread-branches';
import {
  rowInteraction,
  treeClassName,
} from '@/components/molecules/tree-guides';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { threadLevel } from '@/domain/thread-tree';
import type { Draft, Entity, Project, Thread } from '@/domain/workspace';
import { cn } from '@/utility/utils';
import {
  AlertCircleIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
} from 'lucide-react';
import { useState } from 'react';

export type SidebarModel = {
  readonly draft?: Draft;
  readonly editing?: Entity;
  readonly error?: string;
  readonly loadingProjects: boolean;
  readonly loadingThreads: boolean;
  readonly projects: readonly Project[];
  readonly selectedProjectId?: string;
  readonly selectedThreadId?: string;
  readonly threads: readonly Thread[];
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
  readonly startRename: (entity: Entity) => void;
};

type ProjectSidebarProps = {
  readonly actions: SidebarActions;
  readonly model: SidebarModel;
};

export function ProjectSidebar({ actions, model }: ProjectSidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const projectKey = (id: string): string => `project:${id}`;
  const expand = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  const toggle = (id: string) =>
    setCollapsed((current) => {
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
    <Sidebar collapsible="none" className="overflow-hidden">
      <SidebarContent className="p-0">
        <SidebarGroup className="p-0">
          <div className="group/group-label relative">
            <SidebarGroupLabel className="h-7 rounded-none px-3 text-xs">
              Projects
            </SidebarGroupLabel>
            <SidebarGroupAction
              className="pointer-events-none top-1 right-3 opacity-0 group-hover/group-label:pointer-events-auto group-hover/group-label:opacity-100 group-focus-within/group-label:pointer-events-auto group-focus-within/group-label:opacity-100 [&>svg]:size-3!"
              aria-label="New project"
              onClick={actions.beginProject}
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
              {model.draft?.kind === 'project' && (
                <SidebarMenuItem>
                  <DraftName
                    label="New project name"
                    onCancel={actions.cancelDraft}
                    onSubmit={actions.createProject}
                  />
                </SidebarMenuItem>
              )}
              {model.loadingProjects &&
                Array.from({ length: 3 }, (_, index) => (
                  <SidebarMenuItem key={index}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              {model.projects.map((project) => {
                const entity = { kind: 'project', value: project } as const;
                const selected =
                  model.selectedProjectId === project.id &&
                  model.selectedThreadId === undefined;
                const expanded =
                  model.selectedProjectId === project.id &&
                  !collapsed.has(projectKey(project.id));
                const ProjectIcon = expanded ? FolderOpenIcon : FolderIcon;

                return (
                  <SidebarMenuItem key={project.id} className="w-full">
                    <ItemContextMenu
                      addLabel="New thread"
                      deleteLabel="Delete project"
                      onAdd={() => {
                        expand(projectKey(project.id));
                        actions.beginThread(project.id);
                      }}
                      onDelete={() => actions.deleteEntity(entity)}
                    >
                      <div className="group/tree-row relative w-full">
                        <SidebarMenuButton
                          asChild
                          isActive={selected}
                          size="sm"
                          className={cn(
                            'h-7 w-full rounded-none px-3 pr-8 [&>svg]:size-3.5!',
                            rowInteraction(selected),
                          )}
                        >
                          <div
                            role="treeitem"
                            tabIndex={0}
                            onClick={() => {
                              const key = projectKey(project.id);
                              if (selected) toggle(key);
                              else actions.selectProject(project);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                const key = projectKey(project.id);
                                if (selected) toggle(key);
                                else actions.selectProject(project);
                              }
                            }}
                          >
                            <ProjectIcon />
                            <EditableName
                              editing={
                                model.editing?.kind === 'project' &&
                                model.editing.value.id === project.id
                              }
                              label="Project name"
                              value={project.name}
                              onStart={() => actions.startRename(entity)}
                              onCancel={actions.cancelRename}
                              onSubmit={(name) => actions.rename(entity, name)}
                            />
                          </div>
                        </SidebarMenuButton>
                        <RowAddAction
                          label={`New thread in ${project.name}`}
                          onAdd={() => {
                            expand(projectKey(project.id));
                            actions.beginThread(project.id);
                          }}
                        />
                      </div>
                    </ItemContextMenu>
                    {expanded && (
                      <SidebarMenuSub className={treeClassName}>
                        {model.loadingThreads && model.threads.length === 0 && (
                          <SidebarMenuSubItem className="w-full">
                            <SidebarMenuSkeleton className="w-full" />
                          </SidebarMenuSubItem>
                        )}
                        <ThreadBranches
                          actions={threadActions}
                          collapsed={collapsed}
                          depth={1}
                          editingThreadId={
                            model.editing?.kind === 'thread'
                              ? model.editing.value.id
                              : undefined
                          }
                          level={threadLevel(
                            model.threads,
                            model.draft,
                            project.id,
                          )}
                          onExpand={expand}
                          onToggle={toggle}
                          selectedThreadId={model.selectedThreadId}
                        />
                      </SidebarMenuSub>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
