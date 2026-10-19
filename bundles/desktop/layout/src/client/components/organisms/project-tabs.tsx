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
import { HouseIcon } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useState } from 'react';

import type { ProjectTabs } from '../../domain/project-tabs.js';
import { projectIdFromPath } from '../../domain/project-tabs.js';
import type { Project } from '../../domain/workspace.js';
import { EditableName } from '../molecules/editable-name.js';
import { ProjectAvatar } from '../molecules/project-avatar.js';

const tab = cn('group', compactTabClassName);

/**
 * The Dashboard tab's mark: lucide's house, drawn as lucide draws it.
 *
 * Its color is solid on purpose: the paper grays are translucent, and this
 * glyph's strokes overlap at the door, so a translucent color doubles up into
 * patches instead of a clean line. `--muted-foreground` and `--foreground` are
 * the solid pair of the tab's idle and active grays.
 */
function HomeTabIcon() {
  return (
    <HouseIcon
      aria-hidden="true"
      className="-ml-[1px] shrink-0 text-muted-foreground group-data-[active=true]:text-foreground"
      size={15}
    />
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
        // The tab draws its icon alone; the name it lost stays its label.
        aria-label="Dashboard"
        title="Dashboard"
        aria-current={selected === undefined ? 'page' : undefined}
        onClick={() => navigate('/projects')}
      >
        <HomeTabIcon />
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
