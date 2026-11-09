import { useQuery } from '@tanstack/react-query';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from 'desktop/ui/input-group';
import { Kbd, KbdGroup } from 'desktop/ui/kbd';
import { cn } from 'desktop/ui/utils';
import { PlusIcon, SearchIcon } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { api } from '../../api/workspace-api.js';
import {
  dashboardPage,
  searchShortcutKeys,
  searchShortcutLabel,
} from '../../domain/dashboard.js';
import { useDashboardPage } from '../../hooks/use-dashboard-page.js';
import { useRegionItems } from '../../hooks/use-region-items.js';
import type { Workspace } from '../../hooks/use-workspace.js';
import { dashboardStore } from '../../stores/dashboard.js';
import { ElementHost } from '../molecules/element-host.js';
import { type ProjectEntry, ProjectItem } from '../molecules/project-item.js';
import { INSET_CARD } from '../templates/inset-card.js';
import { DashboardSidebar } from './dashboard-sidebar.js';

/**
 * The Dashboard's content card (S34, Figma `85:7726`/`85:7520`): the inset
 * card's look with no padding of its own, 8 px from the window's right and
 * bottom edges, directly after the sidebar.
 */
const CARD = cn(INSET_CARD, 'mr-2 mb-2 flex-1 p-0');

// The Dashboard's primary buttons (New project, Create; Figma
// `layout/Dashboard/Button`): `bg-primary` is Figma's
// `component/layout-primary-dark-bg`, an alias of `base/primary` in both modes,
// and the label is `--paper-control`. The pressed fill mixes 8 % of
// `--primary-foreground` in, approximating Figma's
// `component/layout-primary-dark-pressed` (#4a433b light, #d9cdb6 dark), which
// has no token of its own.

export function Dashboard({
  workspace,
  all,
  navigate,
  createRequest = 0,
  header,
  sidebarHeader,
  onOpenSettings,
}: {
  readonly workspace: Workspace;
  /**
   * True: the Projects list (`/projects`, and `/` unless it was reached
   * through "New project"), with "All projects" selected in the sidebar.
   * False: the home body (`85:7726`), with the same sidebar and no row
   * selected. Both draw their content in the inset card.
   */
  readonly all: boolean;
  readonly navigate: (path: string) => void;
  readonly createRequest?: number;
  /**
   * The content column's top row (G4): the Project tab bar with the account
   * status at its right end (§2.8, `85:7520`). It is drawn once, as the first
   * child of `div[data-slot="dashboard-content"]`, above the content's scroll
   * container. That holds for the list, for a `layout.dashboard.page` page
   * and for the home body alike, so it never scrolls away. `Dashboard`
   * neither reads nor wraps it. Required: the window has no other tab bar on
   * the Dashboard.
   */
  readonly header: ReactNode;
  /**
   * The Dashboard sidebar's header, passed unchanged to
   * `DashboardSidebar.header`. Every form draws it.
   */
  readonly sidebarHeader: ReactNode;
  readonly onOpenSettings: () => void;
}) {
  const [search, setSearch] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  // The sidebar's search, and the home body's own search on the home body:
  // Ctrl+F focuses the home body's while it is shown, else the sidebar's.
  const searchInput = useRef<HTMLInputElement>(null);
  const homeSearchInput = useRef<HTMLInputElement>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const list = useRef<HTMLDivElement>(null);
  const navItems = useRegionItems('layout.dashboard.nav');
  const page = dashboardPage(
    useRegionItems('layout.dashboard.page'),
    useDashboardPage(),
  );
  const beginCreation = useCallback(() => {
    dashboardStore.getState().close();
    setCreating(true);
    requestAnimationFrame(() => nameInput.current?.focus());
  }, []);
  useEffect(() => {
    if (creating) nameInput.current?.focus();
  }, [creating]);
  useEffect(() => {
    if (createRequest > 0) {
      beginCreation();
    }
  }, [createRequest, beginCreation]);
  // The home body draws no `layout.dashboard.page`: it starts with none
  // shown, and a sidebar nav item that shows one opens the list form, which
  // draws it.
  useEffect(() => {
    if (all) return;
    dashboardStore.getState().close();
    return dashboardStore.subscribe((state) => {
      if (state.active !== undefined) navigateRef.current('/projects');
    });
  }, [all]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        const input = (all ? searchInput : homeSearchInput).current;
        input?.focus();
        input?.select();
      } else if (!all && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        beginCreation();
      }
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, [all, beginCreation]);

  const projectVersion = workspace.projects
    .map(({ id, updatedAt }) => `${id}:${updatedAt}`)
    .join('|');
  const activity = useQuery({
    queryKey: ['project-activity', projectVersion],
    queryFn: () => api.projects.activity(),
  });
  const liveProjects = new Map(
    workspace.projects.map((project) => [project.id, project]),
  );
  const entries = (activity.data ?? []).map((entry) => ({
    ...entry,
    project: liveProjects.get(entry.project.id) ?? entry.project,
  }));
  const query = search.trim().toLocaleLowerCase();
  const filtered = query
    ? entries.filter(({ project }) =>
        project.name.toLocaleLowerCase().includes(query),
      )
    : all
      ? entries
      : entries.slice(0, 10);
  const activeId = query
    ? (filtered.find(({ project }) => project.id === highlightedId)?.project
        .id ?? filtered[0]?.project.id)
    : undefined;

  const open = ({ project }: ProjectEntry) => {
    workspace.actions.selectProject(project);
  };
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setSearch('');
      setHighlightedId(null);
      event.currentTarget.blur();
      return;
    }
    if (!query || filtered.length === 0) return;
    if (event.key === 'Enter') {
      const entry = filtered.find(({ project }) => project.id === activeId);
      if (entry) {
        event.preventDefault();
        void open(entry);
      }
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = filtered.findIndex(({ project }) => project.id === activeId);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    const entry = filtered[next];
    if (!entry) return;
    setHighlightedId(entry.project.id);
    const item = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[data-project-id]') ?? [],
    ).find((element) => element.dataset.projectId === entry.project.id);
    item?.scrollIntoView({ block: 'nearest' });
  };

  const changeSearch = (value: string) => {
    if (value !== '') dashboardStore.getState().close();
    setSearch(value);
    setHighlightedId(null);
  };
  const searchField = (
    <label className="group relative flex h-[36px] min-w-0 items-center rounded-[8px] bg-[var(--paper-ghost-hover)] outline-2 -outline-offset-1 outline-transparent focus-within:outline-[var(--paper-focus)]">
      <SearchIcon
        size={14}
        className="pointer-events-none absolute left-[10px] text-[var(--paper-gray-3)] group-focus-within:text-[var(--paper-gray-1)]"
      />
      <input
        ref={homeSearchInput}
        aria-label="Search projects"
        type="text"
        placeholder="Search projects"
        value={search}
        onChange={(event) => changeSearch(event.target.value)}
        onKeyDown={onSearchKeyDown}
        className="h-full w-full min-w-0 bg-transparent pl-[28px] pr-[72px] text-[13px] leading-[16px] text-[var(--paper-gray-1)] outline-none placeholder:text-[var(--paper-gray-4)]"
      />
      {!search && (
        <kbd className="pointer-events-none absolute right-[10px] font-sans text-[12px] leading-[16px] text-[var(--paper-gray-4)]">
          {searchShortcutLabel(navigator.platform)}
        </kbd>
      )}
    </label>
  );
  const dashboardSearch = (
    <InputGroup className="h-9 border-transparent bg-secondary shadow-none">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        ref={searchInput}
        aria-label="Search projects"
        placeholder="Search projects"
        value={search}
        onChange={(event) => changeSearch(event.target.value)}
        onKeyDown={onSearchKeyDown}
      />
      {!search && (
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
  const createForm = creating && (
    <form
      className="flex h-[36px] w-full min-w-0 items-center gap-[6px] rounded-[8px] bg-[var(--paper-ghost-hover)] px-[6px] outline-2 -outline-offset-1 outline-transparent focus-within:outline-[var(--paper-focus)]"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        void workspace.actions
          .createProject(name)
          .then(() => {
            setName('');
            setCreating(false);
          })
          .catch(() => undefined);
      }}
    >
      <input
        ref={nameInput}
        aria-label="Project name"
        placeholder="Project name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setCreating(false);
        }}
        className="min-w-0 flex-1 bg-transparent px-[4px] text-[12px] outline-none"
      />
      <button
        type="submit"
        className="h-[26px] rounded-[6px] bg-primary px-[10px] text-[12px] text-[var(--paper-control)] active:bg-[color-mix(in_oklch,var(--primary),var(--primary-foreground)_8%)]"
      >
        Create
      </button>
      <button
        type="button"
        className="h-[26px] rounded-[6px] px-[8px] text-[12px] hover:bg-[var(--paper-ghost-hover)]"
        onClick={() => setCreating(false)}
      >
        Cancel
      </button>
    </form>
  );
  const listContent =
    activity.isPending || workspace.loadingProjects ? (
      <div
        className="flex flex-col gap-[2px] opacity-50"
        role="status"
        aria-label="Loading projects"
      >
        {[0, 1].map((item) => (
          <div
            key={item}
            className="-mx-[8px] flex items-center gap-[16px] p-[8px]"
          >
            <div className="aspect-[256/168] w-[96px] shrink-0 animate-pulse rounded-[2px] bg-[var(--paper-ghost-hover)]" />
            <div className="h-[14px] w-[180px] max-w-full flex-1 animate-pulse rounded-[4px] bg-[var(--paper-ghost-hover)]" />
            <div className="h-[12px] w-[72px] animate-pulse rounded-[4px] bg-[var(--paper-ghost-hover)]" />
          </div>
        ))}
      </div>
    ) : activity.isError ? (
      <div
        className="py-[64px] text-center text-[12px] text-[var(--paper-gray-3)]"
        role="alert"
      >
        Could not load projects.{' '}
        <button
          type="button"
          className="text-primary"
          onClick={() => void activity.refetch()}
        >
          Retry
        </button>
      </div>
    ) : filtered.length === 0 ? (
      <div className="flex flex-col items-center gap-[16px] py-[64px] text-[12px] text-[var(--paper-gray-3)]">
        <SearchIcon size={24} className="opacity-60" />
        <p>{query ? 'No results found. Maybe a typo?' : 'No projects yet'}</p>
      </div>
    ) : (
      <div
        ref={list}
        className={all ? 'flex flex-col' : 'flex flex-col gap-[2px]'}
      >
        {all && (
          <div
            data-slot="dashboard-columns"
            className="sticky top-[109px] z-[1] flex items-center gap-[16px] bg-[var(--paper-root)] px-[8px] py-[12px] text-[12px] text-[var(--paper-gray-2)]"
          >
            <span className="min-w-0 flex-1">Name</span>
            <span className="min-w-0 flex-1">Activity</span>
            <span className="min-w-0 flex-1">Created</span>
            <span className="min-w-0 flex-1">State</span>
          </div>
        )}
        {filtered.map((entry) => (
          <ProjectItem
            key={entry.project.id}
            entry={entry}
            mode={all ? 'list' : 'recent'}
            highlighted={entry.project.id === activeId}
            workspace={workspace}
            onOpen={(selected) => void open(selected)}
          />
        ))}
      </div>
    );

  const homeBody = (
    <main className="min-h-0 flex-1 overflow-y-auto text-[var(--paper-gray-1)] [scrollbar-gutter:stable_both-edges]">
      <div className="flex min-h-full flex-col items-center px-[40px] pb-[60px] pt-[60px]">
        <div className="mt-[28px] flex w-[520px] max-w-full items-center gap-[10px]">
          <button
            type="button"
            className="inline-flex h-[36px] min-w-0 flex-1 items-center justify-between gap-[8px] rounded-[8px] bg-primary px-[16px] text-[13px] font-normal text-[var(--paper-control)] outline-[var(--paper-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 active:bg-[color-mix(in_oklch,var(--primary),var(--primary-foreground)_8%)]"
            onClick={beginCreation}
          >
            <span>New project</span>
            <kbd className="font-sans text-[12px] font-normal opacity-50">
              {/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘N' : 'Ctrl+N'}
            </kbd>
          </button>
          <button
            type="button"
            className="h-[36px] min-w-0 flex-1 rounded-[8px] bg-[var(--paper-control)] px-[16px] text-[13px] font-normal text-[var(--paper-gray-1)] shadow-[var(--paper-shadow-control)] outline-[var(--paper-focus)] focus-visible:outline-2 focus-visible:-outline-offset-1 active:bg-[var(--paper-control-pressed)]"
            onClick={() => navigate('/projects')}
          >
            Browse all projects
          </button>
        </div>
        <div className="mt-[10px] w-[520px] max-w-full">{searchField}</div>
        {creating && (
          <div className="mt-[10px] w-[520px] max-w-full">{createForm}</div>
        )}
        <div className="mt-[56px] flex w-[520px] max-w-full flex-col gap-[2px]">
          {listContent}
          {!query && entries.length > 0 && !activity.isError && (
            <div className="pt-[10px]">
              <button
                type="button"
                className="text-[12px] text-[var(--paper-gray-3)] hover:text-[var(--paper-gray-1)] focus-visible:rounded-[4px] focus-visible:outline-2 focus-visible:outline-[var(--paper-focus)]"
                onClick={() => navigate('/projects')}
              >
                See all projects
              </button>
            </div>
          )}
          {workspace.error && (
            <p className="py-[12px] text-[12px] text-destructive" role="alert">
              {workspace.error}
            </p>
          )}
        </div>
      </div>
    </main>
  );
  const listBody =
    page !== undefined ? (
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <ElementHost key={page.id} tag={page.tag} className="block h-full" />
      </main>
    ) : (
      <main
        className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      >
        {/* `85:7520`: the header 64 px below the card's top, the title and
            the table on one 1336 px column (147 px in at 1920 px). */}
        <div
          className={`sticky top-0 z-10 border-b bg-[var(--paper-root)] px-[80px] pt-[64px] pb-[12px] max-[900px]:px-[24px] ${scrolled ? 'border-[var(--paper-separator)]' : 'border-transparent'}`}
        >
          <div className="mx-auto flex h-[32px] w-full max-w-[1336px] items-center justify-between gap-[48px]">
            <h1 className="min-w-0 truncate text-[24px] leading-[32px] tracking-[0.005em] text-[var(--paper-gray-1)]">
              Projects
            </h1>
            <div className="flex h-[28px] shrink-0 items-center gap-[12px]">
              <button
                type="button"
                className="flex h-[28px] items-center gap-[6px] rounded-[6px] bg-primary px-[12px] text-[12px] font-normal text-[var(--paper-control)] outline-[var(--paper-focus)] focus-visible:outline-2 active:bg-[color-mix(in_oklch,var(--primary),var(--primary-foreground)_8%)]"
                onClick={beginCreation}
              >
                <PlusIcon size={12} /> New project
              </button>
            </div>
          </div>
        </div>
        <div className="px-[80px] pt-[48px] pb-[32px] max-[900px]:px-[24px]">
          <div className="mx-auto w-full max-w-[1336px]">
            {creating && (
              <div className="mb-[24px] w-[520px] max-w-full">{createForm}</div>
            )}
            {listContent}
            {workspace.error && (
              <p
                className="py-[12px] text-[12px] text-destructive"
                role="alert"
              >
                {workspace.error}
              </p>
            )}
          </div>
        </div>
      </main>
    );

  return (
    <div className="flex min-h-0 flex-1 bg-sidebar">
      <aside className="flex shrink-0" aria-label="Dashboard navigation">
        <DashboardSidebar
          header={sidebarHeader}
          search={dashboardSearch}
          projects={workspace.projects}
          listActive={all && page === undefined}
          navItems={navItems}
          onAllProjects={() => {
            dashboardStore.getState().close();
            if (!all) navigate('/projects');
          }}
          onNewProject={beginCreation}
          onSelectProject={workspace.actions.selectProject}
          onOpenSettings={onOpenSettings}
        />
      </aside>
      <div
        data-slot="dashboard-content"
        className="flex min-w-0 flex-1 flex-col bg-sidebar"
      >
        {header}
        <div data-slot="dashboard-card" className={CARD}>
          {all ? listBody : homeBody}
        </div>
      </div>
    </div>
  );
}
