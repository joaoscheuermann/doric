import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import {
  closestCenter,
  compactTabClassName,
  DndContext,
  horizontalListSortingStrategy,
  restrictToFirstScrollableAncestor,
  restrictToHorizontalAxis,
  SortableContext,
  useSortableTab,
  useTabStrip,
} from 'desktop/ui/panels';
import { cn } from 'desktop/ui/utils';
import { type ReactNode, useLayoutEffect, useState } from 'react';

import type { ProjectTabs } from '../../domain/project-tabs.js';
import { projectIdFromPath } from '../../domain/project-tabs.js';
import type { Project } from '../../domain/workspace.js';
import { EditableName } from '../molecules/editable-name.js';
import { ProjectAvatar } from '../molecules/project-avatar.js';

const tab = cn('group', compactTabClassName);

function HomeTabIcon({ active }: { readonly active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="-ml-[1px] shrink-0"
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="currentColor"
      fillOpacity={active ? 1 : 0.8}
    >
      <path d="M6 2.5C6 2.22386 5.77614 2 5.5 2H2.5C2.22386 2 2 2.22386 2 2.5V5.5C2 5.77614 2.22386 6 2.5 6H5.5C5.77614 6 6 5.77614 6 5.5V2.5ZM7 5.5C7 6.32843 6.32843 7 5.5 7H2.5C1.67157 7 1 6.32843 1 5.5V2.5C1 1.67157 1.67157 1 2.5 1H5.5C6.32843 1 7 1.67157 7 2.5V5.5ZM6 9.5C6 9.22386 5.77614 9 5.5 9H2.5C2.22386 9 2 9.22386 2 9.5V12.5C2 12.7761 2.22386 13 2.5 13H5.5C5.77614 13 6 12.7761 6 12.5V9.5ZM7 12.5C7 13.3284 6.32843 14 5.5 14H2.5C1.67157 14 1 13.3284 1 12.5V9.5C1 8.67157 1.67157 8 2.5 8H5.5C6.32843 8 7 8.67157 7 9.5V12.5ZM13 2.5C13 2.22386 12.7761 2 12.5 2H9.5C9.22386 2 9 2.22386 9 2.5V5.5C9 5.77614 9.22386 6 9.5 6H12.5C12.7761 6 13 5.77614 13 5.5V2.5ZM14 5.5C14 6.32843 13.3284 7 12.5 7H9.5C8.67157 7 8 6.32843 8 5.5V2.5C8 1.67157 8.67157 1 9.5 1H12.5C13.3284 1 14 1.67157 14 2.5V5.5ZM13 9.5C13 9.22386 12.7761 9 12.5 9H9.5C9.22386 9 9 9.22386 9 9.5V12.5C9 12.7761 9.22386 13 9.5 13H12.5C12.7761 13 13 12.7761 13 12.5V9.5ZM14 12.5C14 13.3284 13.3284 14 12.5 14H9.5C8.67157 14 8 13.3284 8 12.5V9.5C8 8.67157 8.67157 8 9.5 8H12.5C13.3284 8 14 8.67157 14 9.5V12.5Z" />
    </svg>
  );
}

function CloseTabIcon() {
  return (
    <svg
      aria-hidden="true"
      className="relative"
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
    >
      <path
        d="M0.465332 0.46447L4.00087 4M4.00087 4L7.53641 7.5355M4.00087 4L7.53641 0.46447M4.00087 4L0.465332 7.5355"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function NewTabIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="-3 -3 16 16"
      fill="none"
      stroke="currentColor"
    >
      <path d="M5 0V5M5 5V10M5 5H10M5 5H0" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ProjectTab({
  project,
  active,
  path,
  index,
  order,
  navigate,
  close,
  closeMany,
  events,
  rename,
}: {
  readonly project: Project;
  readonly active: boolean;
  readonly path: string;
  readonly index: number;
  readonly order: readonly string[];
  readonly navigate: (path: string) => void;
  readonly close: (id: string) => void;
  readonly closeMany: (ids: readonly string[]) => void;
  readonly events: ReturnType<typeof useTabStrip>;
  readonly rename: (project: Project, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  // "Rename" opens the name only once the menu has closed, so the focus the
  // menu would hand back cannot leave the name it just opened.
  const [renameFromMenu, setRenameFromMenu] = useState(false);
  const sortable = useSortableTab(project.id, events.frozen?.get(project.id));
  // Reordering is a visibility trigger even when the active flag stays true.
  // biome-ignore lint/correctness/useExhaustiveDependencies: index triggers scrolling after keyboard reordering
  useLayoutEffect(() => {
    if (active && !events.sorting)
      sortable.node.current?.scrollIntoView({
        inline: 'nearest',
        block: 'nearest',
      });
  }, [active, events.sorting, index]);

  const closeThis = () => close(project.id);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            // The sortable's own ref is stable: a drag re-renders every tab on
            // each pointer move, and a new ref callback would detach and
            // re-observe each tab's node every time.
            ref={sortable.setNodeRef}
            data-tab-id={project.id}
            className={cn(
              tab,
              'min-w-[100px] max-w-[280px] shrink-0 motion-reduce:!transition-none',
            )}
            style={sortable.style}
            data-active={active ? 'true' : undefined}
          />
        }
      >
        {editing ? (
          <EditableName
            editing
            label="Project name"
            value={project.name}
            onCancel={() => setEditing(false)}
            onSubmit={async (name) => {
              await rename(project, name);
              setEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 touch-none items-center gap-[6px] text-left outline-none"
            ref={sortable.setActivatorNodeRef}
            {...sortable.attributes}
            {...sortable.listeners}
            aria-label={project.name}
            aria-keyshortcuts="Space Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
            onKeyDown={(event) => {
              events.keyDown(event, project.id);
              if (!event.defaultPrevented)
                sortable.listeners?.onKeyDown?.(event);
            }}
            aria-current={active ? 'page' : undefined}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                closeThis();
              }
            }}
            onClick={() => {
              if (!events.sorting) navigate(path);
            }}
            onDoubleClick={() => setEditing(true)}
            title={project.name}
          >
            <span className="flex size-[16px] shrink-0 items-center justify-center">
              <ProjectAvatar color={project.color} className="size-[12px]" />
            </span>
            <span className="min-w-0 truncate">{project.name}</span>
          </button>
        )}
        <button
          type="button"
          className="relative -right-[4px] -ml-[8px] flex size-[28px] shrink-0 items-center justify-center opacity-0 before:absolute before:inset-[4px] before:rounded-[4px] hover:!opacity-100 hover:before:bg-[color-mix(in_srgb,currentColor_8%,transparent)] group-hover:opacity-50 group-data-[active=true]:opacity-50 focus-visible:opacity-100"
          aria-label={`Close ${project.name} tab`}
          disabled={events.sorting}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              closeThis();
            }
          }}
          onClick={closeThis}
        >
          <CloseTabIcon />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent
        finalFocus={
          renameFromMenu
            ? () => {
                setRenameFromMenu(false);
                setEditing(true);
                return false;
              }
            : undefined
        }
      >
        <ContextMenuGroup>
          <ContextMenuItem
            onClick={() =>
              navigate(`/projects/${encodeURIComponent(project.id)}`)
            }
          >
            Open project
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setRenameFromMenu(true)}>
            Rename
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem onClick={closeThis}>Close tab</ContextMenuItem>
          <ContextMenuItem
            disabled={order.length < 2}
            onClick={() => closeMany(order.filter((id) => id !== project.id))}
          >
            Close other tabs
          </ContextMenuItem>
          <ContextMenuItem
            disabled={index === order.length - 1}
            onClick={() => closeMany(order.slice(index + 1))}
          >
            Close tabs to the right
          </ContextMenuItem>
          <ContextMenuItem onClick={() => closeMany(order)}>
            Close all tabs
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ProjectTabBar({
  actions,
  trailing = true,
  state,
  path,
  projects,
  navigate,
  close,
  closeMany,
  move,
  onNewProject,
  rename,
}: {
  readonly actions?: ReactNode;
  /** Whether this strip reaches the window's trailing native controls. */
  readonly trailing?: boolean;
  readonly state: ProjectTabs;
  readonly path: string;
  readonly projects: readonly Project[];
  readonly navigate: (path: string) => void;
  readonly close: (id: string) => void;
  readonly closeMany: (ids: readonly string[]) => void;
  readonly move: (from: string, to: string) => void;
  readonly onNewProject: () => void;
  readonly rename: (project: Project, name: string) => Promise<void>;
}) {
  const selected = projectIdFromPath(path);
  const mac = navigator.userAgent.includes('Mac');
  const events = useTabStrip(state.order, selected, move);
  return (
    <nav
      aria-label="Workspace tabs"
      className={`flex h-[40px] min-h-[40px] min-w-0 items-center gap-[4px] border-b border-[var(--paper-separator)] bg-[var(--paper-panel)] pr-[8px] [-webkit-app-region:drag] ${mac ? 'pl-[var(--doric-safe-left,80px)]' : trailing ? 'pl-[8px] pr-[140px]' : 'pl-[8px]'}`}
    >
      <button
        type="button"
        className={`${tab} shrink-0 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-[var(--paper-focus)]`}
        data-active={selected === undefined ? 'true' : undefined}
        aria-current={selected === undefined ? 'page' : undefined}
        onClick={() => navigate('/projects')}
      >
        <HomeTabIcon active={selected === undefined} />
        <span>Dashboard</span>
      </button>
      <div
        aria-hidden="true"
        className="h-[18px] w-px shrink-0 border-r border-[var(--paper-separator)]"
      />
      {state.order.length > 0 && (
        <DndContext
          sensors={events.sensors}
          collisionDetection={closestCenter}
          modifiers={[
            restrictToHorizontalAxis,
            restrictToFirstScrollableAncestor,
          ]}
          onDragStart={events.start}
          onDragEnd={events.end}
          onDragCancel={events.cancel}
        >
          <div
            ref={events.root}
            className="-mx-[4px] flex h-full min-w-0 flex-initial items-center gap-[4px] overflow-x-auto overflow-y-hidden px-[4px] [-webkit-app-region:drag] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <SortableContext
              items={[...state.order]}
              strategy={horizontalListSortingStrategy}
            >
              {state.order.map((id, index) => {
                const project = projects.find((item) => item.id === id);
                if (!project) return null;
                return (
                  <ProjectTab
                    key={id}
                    project={project}
                    active={selected === id}
                    path={
                      state.paths[id] ?? `/projects/${encodeURIComponent(id)}`
                    }
                    index={index}
                    order={state.order}
                    navigate={navigate}
                    close={close}
                    closeMany={closeMany}
                    events={events}
                    rename={rename}
                  />
                );
              })}
            </SortableContext>
          </div>
        </DndContext>
      )}
      <button
        type="button"
        className={`flex size-[28px] shrink-0 items-center justify-center rounded-[6px] text-[var(--paper-gray-3)] hover:bg-[color-mix(in_srgb,currentColor_7.5%,transparent)] hover:text-[var(--paper-gray-1)] focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-[var(--paper-focus)] [-webkit-app-region:no-drag] ${state.order.length > 0 ? '-mx-[2px]' : ''}`}
        aria-label="New project"
        title="New project"
        onClick={onNewProject}
      >
        <NewTabIcon />
      </button>
      {actions && (
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 pl-3 [-webkit-app-region:no-drag]">
          {actions}
        </div>
      )}
    </nav>
  );
}
