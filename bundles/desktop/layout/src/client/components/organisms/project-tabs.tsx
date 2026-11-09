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
import { PencilIcon, PlusIcon, XIcon } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useState } from 'react';

import type { ProjectTabs } from '../../domain/project-tabs.js';
import { projectIdFromPath } from '../../domain/project-tabs.js';
import type { Project, ProjectColor } from '../../domain/workspace.js';
import { EditableName } from '../molecules/editable-name.js';
import { ProjectAvatar } from '../molecules/project-avatar.js';
import { ProjectColorMenu } from '../molecules/project-color-menu.js';

const tab = cn('group', compactTabClassName);

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
  newThread,
  setColor,
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
  readonly newThread: (project: Project) => void;
  readonly setColor: (project: Project, color?: ProjectColor) => void;
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
              // 172 px wide, as every `ProjectTab` in the prototype
              // (`99:8035`, `85:7520`); they shrink to 100 px before the
              // strip scrolls.
              'w-[172px] min-w-[100px] shrink motion-reduce:!transition-none',
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
        {/* Figma `layout/ContextMenu` ProjectTab (363:230, note 364:23948):
            no "Open project" (the tab is the Project); the close entries
            without an icon are inset; one that would close nothing is
            hidden, not disabled. */}
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => newThread(project)}>
            <PlusIcon />
            New thread
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setRenameFromMenu(true)}>
            <PencilIcon />
            Rename
          </ContextMenuItem>
          <ProjectColorMenu
            value={project.color}
            onSelect={(color) => setColor(project, color)}
          />
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem onClick={closeThis}>
            <XIcon />
            Close tab
          </ContextMenuItem>
          {order.length > 1 && (
            <ContextMenuItem
              inset
              onClick={() => closeMany(order.filter((id) => id !== project.id))}
            >
              Close other tabs
            </ContextMenuItem>
          )}
          {index < order.length - 1 && (
            <ContextMenuItem
              inset
              onClick={() => closeMany(order.slice(index + 1))}
            >
              Close tabs to the right
            </ContextMenuItem>
          )}
          <ContextMenuItem inset onClick={() => closeMany(order)}>
            Close all tabs
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The Project tab bar (§2.3): one tab per open Project, the "New project"
 * button, and `actions` at the right end. It is 40 px high and a window drag
 * region, apart from its controls. It is transparent on the canvas and has no
 * bottom border. It draws no Dashboard tab: the sidebar header's Dashboard
 * button replaces it (§2.2). It keeps no right-edge reserve (G2).
 */
export function ProjectTabBar({
  actions,
  inset = false,
  state,
  path,
  projects,
  navigate,
  close,
  closeMany,
  move,
  onNewProject,
  rename,
  onNewThread,
  setColor,
}: {
  /**
   * What the bar draws at its right end, after "New project", outside the drag
   * region, in `div[data-slot="project-tab-actions"]`. The workspace view
   * passes the `layout.header` region, followed by the controls of the Files
   * column while that column is collapsed (S27). On the Dashboard it passes the
   * account status alone (G13). Absent: nothing is drawn.
   */
  readonly actions?: ReactNode;
  /**
   * Whether the bar starts at the window's left edge, where macOS draws its
   * window controls. When true, it keeps the `--doric-safe-left` padding so the
   * first tab clears those controls (G3). When false (the default), it starts
   * at the edge of the column before it.
   */
  readonly inset?: boolean;
  readonly state: ProjectTabs;
  /** The window path. The tab whose Project it names is selected; `/` and `/projects` select none. */
  readonly path: string;
  readonly projects: readonly Project[];
  /** Opens a Project tab's remembered path. */
  readonly navigate: (path: string) => void;
  readonly close: (id: string) => void;
  readonly closeMany: (ids: readonly string[]) => void;
  readonly move: (from: string, to: string) => void;
  readonly onNewProject: () => void;
  readonly rename: (project: Project, name: string) => Promise<void>;
  /** A3 (§4.4): selects the Project and starts a Thread draft in it. */
  readonly onNewThread: (project: Project) => void;
  /** A4 (§4.4): the Project's color, as the Dashboard row's menu sets it. */
  readonly setColor: (project: Project, color?: ProjectColor) => void;
}) {
  const selected = projectIdFromPath(path);
  const mac = navigator.userAgent.includes('Mac');
  const events = useTabStrip(state.order, selected, move);
  return (
    <nav
      aria-label="Workspace tabs"
      className={`flex h-[40px] min-h-[40px] min-w-0 items-center gap-[4px] pr-[8px] [-webkit-app-region:drag] ${inset ? (mac ? 'pl-[var(--doric-safe-left,80px)]' : 'pl-[8px]') : 'pl-0'}`}
    >
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
                    newThread={onNewThread}
                    setColor={setColor}
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
        <div
          data-slot="project-tab-actions"
          className="ml-auto flex min-w-0 shrink-0 items-center gap-2 pl-3 [-webkit-app-region:no-drag]"
        >
          {actions}
        </div>
      )}
    </nav>
  );
}
