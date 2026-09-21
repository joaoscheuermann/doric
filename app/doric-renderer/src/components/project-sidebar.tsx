import type { Draft, Entity, Project, Thread } from '@/app/workspace';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { cn } from 'cn';
import {
  AlertCircleIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { EditableName } from './editable-name';
import { InlineName } from './inline-name';

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

type ThreadBranchProps = {
  readonly actions: SidebarActions;
  readonly collapsed: ReadonlySet<string>;
  readonly depth: number;
  readonly model: SidebarModel;
  readonly onExpand: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly parentThreadId?: string;
  readonly projectId: string;
};

const treeClassName = 'mx-0 w-full translate-x-0 gap-0 border-0 px-0 py-0';
const treeStep = 1.5;
const indentation = (depth: number): string => `${0.75 + depth * treeStep}rem`;
const guidePosition = (level: number): string =>
  `${1.1875 + level * treeStep}rem`;
const rowInteraction = (selected: boolean): string =>
  selected
    ? 'hover:bg-sidebar-accent active:bg-sidebar-accent'
    : 'hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground';

function TreeGuides({ depth }: { readonly depth: number }) {
  if (depth === 0) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="absolute inset-y-0 w-px bg-sidebar-border"
          style={{ left: guidePosition(level) }}
        />
      ))}
    </span>
  );
}

function ItemContextMenu({
  addLabel,
  children,
  deleteLabel,
  onAdd,
  onCopyId,
  onDelete,
}: {
  readonly addLabel: string;
  readonly children: ReactNode;
  readonly deleteLabel: string;
  readonly onAdd: () => void;
  readonly onCopyId?: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onSelect={onAdd}>
            <PlusIcon />
            {addLabel}
          </ContextMenuItem>
          {onCopyId && (
            <ContextMenuItem onSelect={onCopyId}>
              <CopyIcon />
              Copy thread ID
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2Icon />
            {deleteLabel}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RowAddAction({
  label,
  onAdd,
}: {
  readonly label: string;
  readonly onAdd: () => void;
}) {
  return (
    <SidebarMenuAction
      type="button"
      className="pointer-events-none right-1 opacity-0 after:inset-0 group-hover/tree-row:pointer-events-auto group-hover/tree-row:opacity-100 group-focus-within/tree-row:pointer-events-auto group-focus-within/tree-row:opacity-100 [&>svg]:size-3!"
      style={{ top: '0.25rem' }}
      aria-label={label}
      onClick={onAdd}
    >
      <PlusIcon />
    </SidebarMenuAction>
  );
}

function DraftName({
  depth,
  initialValue,
  label,
  onCancel,
  onSubmit,
}: {
  readonly depth?: number;
  readonly initialValue?: string;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
}) {
  return (
    <div
      className="relative w-full pr-3"
      style={{
        paddingLeft: depth === undefined ? '0.75rem' : indentation(depth),
      }}
    >
      <TreeGuides depth={depth ?? 0} />
      <InlineName
        initialValue={initialValue}
        label={label}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    </div>
  );
}

function ThreadBranch({
  actions,
  collapsed,
  depth,
  model,
  onExpand,
  onToggle,
  parentThreadId,
  projectId,
}: ThreadBranchProps) {
  const children = model.threads.filter(
    (thread) =>
      thread.projectId === projectId &&
      thread.parentThreadId === parentThreadId,
  );
  const showDraft =
    model.draft?.kind === 'thread' &&
    model.draft.projectId === projectId &&
    model.draft.parentThreadId === parentThreadId;

  return (
    <>
      {children.map((thread) => {
        const entity = { kind: 'thread', value: thread } as const;
        const selected = model.selectedThreadId === thread.id;
        const childCount = model.threads.some(
          (candidate) =>
            candidate.projectId === projectId &&
            candidate.parentThreadId === thread.id,
        );
        const hasDraftChild =
          model.draft?.kind === 'thread' &&
          model.draft.projectId === projectId &&
          model.draft.parentThreadId === thread.id;
        const expandable = childCount || hasDraftChild;
        const expanded = expandable && !collapsed.has(thread.id);
        const ThreadIcon = expandable ? ChevronRightIcon : MessageSquareIcon;

        return (
          <SidebarMenuSubItem key={thread.id} className="w-full">
            <ItemContextMenu
              addLabel="New child thread"
              deleteLabel="Delete thread"
              onAdd={() => {
                onExpand(thread.id);
                actions.beginThread(thread.projectId, thread.id);
              }}
              onCopyId={() => actions.copyThreadId(thread.id)}
              onDelete={() => actions.deleteEntity(entity)}
            >
              <div className="group/tree-row relative w-full">
                <TreeGuides depth={depth} />
                <SidebarMenuSubButton
                  asChild
                  isActive={selected}
                  size="sm"
                  className={cn(
                    'h-7 w-full translate-x-0 rounded-none pr-8 [&>svg]:size-3.5!',
                    rowInteraction(selected),
                  )}
                  style={{ paddingLeft: indentation(depth) }}
                >
                  <div
                    role="treeitem"
                    tabIndex={0}
                    onClick={() => {
                      if (selected && expandable) onToggle(thread.id);
                      else actions.selectThread(thread);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (selected && expandable) onToggle(thread.id);
                        else actions.selectThread(thread);
                      }
                    }}
                  >
                    <ThreadIcon
                      className={cn(
                        expandable &&
                          'transition-transform duration-[50ms] ease-out',
                        expandable && (expanded ? 'rotate-90' : 'rotate-0'),
                      )}
                    />
                    <EditableName
                      editing={
                        model.editing?.kind === 'thread' &&
                        model.editing.value.id === thread.id
                      }
                      label="Thread name"
                      value={thread.name}
                      onStart={() => actions.startRename(entity)}
                      onCancel={actions.cancelRename}
                      onSubmit={(name) => actions.rename(entity, name)}
                    />
                  </div>
                </SidebarMenuSubButton>
                <RowAddAction
                  label={`New child thread in ${thread.name}`}
                  onAdd={() => {
                    onExpand(thread.id);
                    actions.beginThread(thread.projectId, thread.id);
                  }}
                />
              </div>
            </ItemContextMenu>
            {expandable && expanded && (
              <SidebarMenuSub className={treeClassName}>
                <ThreadBranch
                  actions={actions}
                  collapsed={collapsed}
                  depth={depth + 1}
                  model={model}
                  onExpand={onExpand}
                  onToggle={onToggle}
                  parentThreadId={thread.id}
                  projectId={projectId}
                />
              </SidebarMenuSub>
            )}
          </SidebarMenuSubItem>
        );
      })}
      {showDraft && (
        <SidebarMenuSubItem className="w-full">
          <DraftName
            depth={depth}
            label="New thread name"
            onCancel={actions.cancelDraft}
            onSubmit={actions.createThread}
          />
        </SidebarMenuSubItem>
      )}
    </>
  );
}

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
                        <ThreadBranch
                          actions={actions}
                          collapsed={collapsed}
                          depth={1}
                          model={model}
                          onExpand={expand}
                          onToggle={toggle}
                          projectId={project.id}
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
