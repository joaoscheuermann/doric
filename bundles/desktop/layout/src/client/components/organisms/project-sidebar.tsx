import { Alert, AlertDescription, AlertTitle } from 'desktop/ui/alert';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from 'desktop/ui/input-group';
import { Kbd, KbdGroup } from 'desktop/ui/kbd';
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
import {
  AlertCircleIcon,
  ChevronRightIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react';
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { usePanelRef } from 'react-resizable-panels';

import type { StackPane } from '../../../contracts/index.js';
import { searchShortcutKeys } from '../../domain/dashboard.js';
import { threadIconKind } from '../../domain/sidebar.js';
import {
  PANE_HEADER,
  paneExpanded,
  THREADS_PANE_ID,
} from '../../domain/sidebar-stack.js';
import { filterThreadTree } from '../../domain/thread-filter.js';
import { threadLevel } from '../../domain/thread-tree.js';
import type {
  Draft,
  Entity,
  Project,
  ProjectColor,
  Thread,
} from '../../domain/workspace.js';
import { openThreadTab } from '../../hooks/thread-navigation.js';
import { usePaneOpen, useStackPanes } from '../../hooks/use-stack-panes.js';
import { setPaneOpen, togglePane } from '../../stores/stack.js';
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
 *
 * `headless`: the pane is the stack's only one (plan-4 G5, Figma `99:8035`
 * draws no Threads header), so it draws no header, cannot collapse and always
 * shows its content.
 */
function PanePanel({
  action,
  children,
  headless = false,
  pane,
}: {
  readonly action?: ReactNode;
  readonly children?: ReactNode;
  readonly headless?: boolean;
  readonly pane: StackPane;
}) {
  const open = usePaneOpen(pane.id) || headless;
  const panel = usePanelRef();
  const header = useRef<HTMLDivElement>(null);
  const collapsible = pane.collapsible !== false && !headless;

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
        {!headless && (
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
        )}
        {/* The rows sit 6 px in from the column edges (Figma `269:31402`:
            ProjectSidebar at x 6, 268 wide), so their 4 px rounded
            selection fill does not touch them. */}
        {open && (
          <SidebarGroupContent className="min-h-0 w-full flex-1 overflow-y-auto px-1.5">
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
 * lucide `PlusIcon` and the text "New Thread", 12 px under the search field
 * and 12 px above the tree (plan-4 G4).
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
    <SidebarMenu>
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
  const level =
    projectId === undefined
      ? undefined
      : threadLevel(threads, model.draft, projectId);
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
      <div ref={tree} className="contents">
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
              {...(filter === undefined ? {} : { filter })}
              repo={threadIconKind}
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
    </>
  );

  const paneAction = (pane: StackPane): ReactNode =>
    pane.id === THREADS_PANE_ID || pane.headerTag === undefined ? null : (
      <ElementHost tag={pane.headerTag} />
    );

  return (
    <Sidebar collapsible="none" className="overflow-hidden font-normal">
      {header}
      {/* Not clipped: the search field's focus ring (3 px) reaches above the
          content's top edge, into the header's last 3 px. The panes below
          bound their own overflow. */}
      <SidebarContent className="overflow-visible p-0">
        {/* Figma `269:31402`: the field 268×36 at y 40, New Thread at y 88,
            the tree at y 128 (px 6, 12 px gaps; plan-4 G4). */}
        <div className="flex shrink-0 flex-col gap-3 px-1.5 pb-3">
          <ThreadSearch
            input={searchInput}
            value={query}
            onChange={setQuery}
            onKeyDown={onSearchKeyDown}
          />
          <NewThreadRow
            onBegin={projectId === undefined ? undefined : () => beginThread()}
          />
        </div>
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          {panes.map((pane, index) => (
            <Fragment key={pane.id}>
              {index > 0 && <ResizableHandle />}
              <PanePanel
                action={paneAction(pane)}
                headless={panes.length === 1}
                pane={pane}
              >
                {pane.id === THREADS_PANE_ID ? threadsContent : undefined}
              </PanePanel>
            </Fragment>
          ))}
        </ResizablePanelGroup>
      </SidebarContent>
    </Sidebar>
  );
}
