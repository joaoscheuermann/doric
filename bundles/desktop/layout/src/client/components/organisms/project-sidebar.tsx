import { Alert, AlertDescription, AlertTitle } from 'desktop/ui/alert';
import { Button } from 'desktop/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from 'desktop/ui/input-group';
import { Kbd, KbdGroup } from 'desktop/ui/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import {
  AlertCircleIcon,
  ChevronRightIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { StackPane } from '../../../contracts/index.js';
import { searchShortcutKeys } from '../../domain/dashboard.js';
import { filterThreadTree } from '../../domain/thread-filter.js';
import {
  type ThreadActivity,
  threadActivity,
  threadLevel,
} from '../../domain/thread-tree.js';
import type {
  Draft,
  Entity,
  Project,
  ProjectColor,
  Thread,
} from '../../domain/workspace.js';
import { openThreadTab } from '../../hooks/thread-navigation.js';
import { usePaneOpen, useStackPanes } from '../../hooks/use-stack-panes.js';
import { useThreadRows } from '../../hooks/use-thread-rows.js';
import { togglePane } from '../../stores/stack.js';
import { threadRowsBusy } from '../../stores/thread-rows.js';
import { ElementHost } from '../molecules/element-host.js';
import { SEARCH_FIELD } from '../molecules/search-field.js';
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
   * The column's 40 px header (`SidebarHeader`), drawn as the first child of
   * the `<Sidebar collapsible="none">`, above the search field, the Thread
   * region and the panes. Absent: the search field starts at the top.
   */
  readonly header?: ReactNode;
  readonly model: SidebarModel;
};

/**
 * One group of the sidebar's stack (`layout.stack/v2`): the pane's 28 px
 * header the layout draws — its title, its collapse control and its own action
 * element, shown while the header is hovered or holds focus — and, while open,
 * the pane's element. The group is as tall as its content, at most 40% of the
 * column, and never shorter than its header, so it cannot vanish; past the cap
 * its content scrolls.
 */
function StackPaneGroup({
  action,
  pane,
}: {
  readonly action?: ReactNode;
  readonly pane: StackPane;
}) {
  const open = usePaneOpen(pane.id);
  const collapsible = pane.collapsible !== false;

  return (
    <SidebarGroup
      data-slot="sidebar-pane"
      data-pane-id={pane.id}
      className="flex max-h-[40%] min-h-7 flex-col p-0"
    >
      <div className="group/pane-header relative shrink-0">
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
        {action !== undefined && (
          <div className="pointer-events-none opacity-0 group-hover/pane-header:pointer-events-auto group-hover/pane-header:opacity-100 group-focus-within/pane-header:pointer-events-auto group-focus-within/pane-header:opacity-100">
            {action}
          </div>
        )}
      </div>
      {/* The rows sit 6 px in from the column edges (Figma `269:31402`:
          ProjectSidebar at x 6, 268 wide), so their 4 px rounded selection
          fill does not touch them. */}
      {open && (
        <SidebarGroupContent className="min-h-0 w-full flex-1 overflow-y-auto px-1.5">
          {pane.tag !== undefined && (
            <ElementHost
              tag={pane.tag}
              {...(pane.props === undefined ? {} : { props: pane.props })}
            />
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}

/**
 * The "Search Threads" field under the sidebar header (§4.3, Figma
 * `I269:31402;331:42177`, plan-4 G4): the Dashboard's search look
 * (`InputGroup` with `SEARCH_FIELD`), lucide
 * `SearchIcon`, placeholder and accessible name "Search Threads", and the
 * shortcut keys (`searchShortcutKeys`) while it is empty.
 */
function ThreadSearch({
  input,
  onChange,
  onKeyDown,
  value,
}: {
  readonly input: RefObject<HTMLInputElement | null>;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly value: string;
}) {
  return (
    <InputGroup className={SEARCH_FIELD}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        ref={input}
        aria-label="Search Threads"
        placeholder="Search Threads"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {!value && (
        <InputGroupAddon align="inline-end">
          <KbdGroup>
            {searchShortcutKeys(navigator.platform).map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/**
 * S13: ⌘F or Ctrl+F (no Alt, no Shift), not yet prevented, from anywhere but
 * a Monaco editor or a terminal.
 */
const isSearchShortcut = (event: globalThis.KeyboardEvent): boolean => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
    return false;
  if (event.key.toLowerCase() !== 'f' || event.defaultPrevented) return false;
  const { target } = event;
  return !(
    target instanceof Element &&
    target.closest('.monaco-editor, .xterm') !== null
  );
};

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
  // The search query (§4.3): never persisted, cleared with the Project.
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const [treeFocus, setTreeFocus] = useState(0);
  const [queryProject, setQueryProject] = useState(projectId);
  if (queryProject !== projectId) {
    setQueryProject(projectId);
    setQuery('');
  }
  // G7 for drafts begun outside the sidebar (A3, the Project tab's "New
  // thread"): a new draft ends the query, so its row shows.
  const [queryDraft, setQueryDraft] = useState(model.draft);
  if (queryDraft !== model.draft) {
    setQueryDraft(model.draft);
    if (model.draft !== undefined) setQuery('');
  }
  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      searchInput.current?.focus();
      searchInput.current?.select();
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);
  // G8: after Escape, the selected Thread's row, else the first row; with no
  // row the field keeps focus.
  useEffect(() => {
    if (treeFocus === 0) return;
    const rows = tree.current;
    const row =
      rows?.querySelector<HTMLElement>('[role="treeitem"][data-active]') ??
      rows?.querySelector<HTMLElement>('[role="treeitem"]');
    row?.focus();
  }, [treeFocus]);
  const threadRows = useThreadRows();
  const level =
    projectId === undefined
      ? undefined
      : threadLevel(threads, model.draft, projectId);
  // Every Thread of the Project, drawn or not, so a hidden busy descendant
  // still makes its ancestors active (§2).
  const activity =
    level === undefined
      ? new Map<string, ThreadActivity>()
      : threadActivity(level, (id) => threadRowsBusy(threadRows, id));
  const filter =
    query === '' || level === undefined
      ? undefined
      : filterThreadTree(level.nodes, query);
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setQuery('');
    setTreeFocus((count) => count + 1);
  };
  // G7: a draft is not in the filter, so beginning one ends the query.
  const beginThread = (parentThreadId?: string) => {
    if (projectId === undefined) return;
    setQuery('');
    actions.beginThread(projectId, parentThreadId);
  };
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
    beginChild: (thread) => {
      setQuery('');
      actions.beginThread(thread.projectId, thread.id);
    },
    cancelDraft: actions.cancelDraft,
    cancelRename: actions.cancelRename,
    copyId: actions.copyThreadId,
    create: actions.createThread,
    delete: (thread) => actions.deleteEntity({ kind: 'thread', value: thread }),
    openInTab: (thread) => void openThreadTab(thread),
    rename: (thread, name) =>
      actions.rename({ kind: 'thread', value: thread }, name),
    select: actions.selectThread,
    startRename: (thread) =>
      actions.startRename({ kind: 'thread', value: thread }),
  };

  // The Thread region's scroller: the alert, the skeleton rows, the tree and
  // the empty notice. It carries `-mx-1.5 px-1.5` so it reaches the column
  // edges (the rows' focus ring is not clipped) while the button keeps x 6.
  const threadTree = (
    <div
      ref={tree}
      data-slot="thread-tree"
      className="-mx-1.5 min-h-0 overflow-y-auto px-1.5"
    >
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
            activity={activity}
            collapsed={collapsedThreads}
            depth={0}
            editingThreadId={
              model.editing?.kind === 'thread'
                ? model.editing.value.id
                : undefined
            }
            {...(filter === undefined ? {} : { filter })}
            level={level ?? threadLevel(threads, model.draft, projectId)}
            onExpand={expandThread}
            onToggle={toggleThread}
            selectedThreadId={model.selectedThreadId}
          />
        )}
        {filter !== undefined && filter.shown.size === 0 && !loading && (
          <SidebarMenuItem
            data-threads-empty=""
            className="px-2.5 py-1 text-[13px] leading-[19.5px] text-muted-foreground"
          >
            No threads match
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </div>
  );

  const paneAction = (pane: StackPane): ReactNode =>
    pane.headerTag === undefined ? null : <ElementHost tag={pane.headerTag} />;

  return (
    <Sidebar collapsible="none" className="overflow-hidden font-normal">
      {header}
      {/* Not clipped: the search field's focus ring (3 px) reaches above the
          content's top edge, into the header's last 3 px. The Thread tree and
          the panes below bound their own overflow; 14 px below the last
          pane. */}
      <SidebarContent className="overflow-visible p-0 pb-3.5">
        {/* Figma `269:31402`: the field 268×36 at y 40, then the tree, the New
            Thread button under it, and the panes pinned to the bottom (px 6,
            12 px gaps). */}
        <div className="shrink-0 px-1.5 pb-3">
          <ThreadSearch
            input={searchInput}
            value={query}
            onChange={setQuery}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        {/* The Thread region gives up its free height first; it keeps 40 px,
            so the button never leaves the column. */}
        <div
          data-slot="thread-region"
          className="flex min-h-10 flex-1 flex-col gap-3 px-1.5"
        >
          {threadTree}
          <Button
            variant="secondary"
            size="sm"
            aria-label="New Thread"
            className="w-full shrink-0"
            disabled={projectId === undefined}
            onClick={() => beginThread()}
          >
            <PlusIcon />
          </Button>
        </div>
        {panes.map((pane) => (
          <StackPaneGroup key={pane.id} action={paneAction(pane)} pane={pane} />
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
