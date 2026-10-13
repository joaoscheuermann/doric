import { useQuery } from '@tanstack/react-query';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import { FolderIcon, PlusIcon, SearchIcon } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { api } from '../../api/workspace-api.js';
import type { Workspace } from '../../hooks/use-workspace.js';
import { ProjectAvatar } from '../molecules/project-avatar.js';
import { ProjectColorMenu } from '../molecules/project-color-menu.js';

type Entry = Awaited<ReturnType<typeof api.projects.activity>>[number];
type ViewMode = 'grid' | 'list';

function relativeTime(value: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60_000),
  );
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 1_440) {
    const hours = Math.floor(minutes / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(minutes / 1_440);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function ProjectItem({
  entry,
  mode,
  highlighted,
  workspace,
  onOpen,
}: {
  readonly entry: Entry;
  readonly mode: 'recent' | ViewMode;
  readonly highlighted: boolean;
  readonly workspace: Workspace;
  readonly onOpen: (entry: Entry) => void;
}) {
  const { project, activityAt } = entry;
  const remove = () =>
    workspace.actions.requestDelete({ kind: 'project', value: project });
  const isGrid = mode === 'grid';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-project-id={project.id}
          className={
            isGrid
              ? `group relative min-w-0 overflow-hidden rounded-[8px] bg-[var(--paper-control)] outline -outline-offset-1 dark:bg-[var(--paper-panel)] ${highlighted ? 'outline-2 outline-[var(--paper-focus)]' : 'outline-1 outline-black/5 dark:outline-white/5'}`
              : `group relative -mx-[8px] flex min-w-0 items-center rounded-[6px] p-[8px] hover:bg-[var(--paper-ghost-hover)] ${highlighted ? 'bg-[var(--paper-thumbnail-selected)] outline outline-2 -outline-offset-2 outline-[var(--paper-focus)]' : ''}`
          }
        >
          <button
            type="button"
            className={
              isGrid
                ? 'block w-full min-w-0 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--paper-focus)]'
                : 'flex w-full min-w-0 items-center gap-[16px] text-left outline-none focus-visible:rounded-[6px] focus-visible:outline-2 focus-visible:outline-[var(--paper-focus)]'
            }
            onClick={() => onOpen(entry)}
          >
            {isGrid ? (
              <>
                <span className="flex min-w-0 flex-col items-start p-[8px] pt-[6px] text-[12px] leading-[18px]">
                  <span className="flex min-h-[22px] max-w-full items-center truncate text-[var(--paper-gray-1)]">
                    {project.name}
                  </span>
                  <span className="max-w-full truncate capitalize text-[var(--paper-gray-3)]">
                    {project.state} · {relativeTime(activityAt)}
                  </span>
                </span>
                <span className="m-[4px] mt-0 grid aspect-[256/168] place-items-center overflow-hidden rounded-[4px] bg-[var(--paper-thumbnail)]">
                  <ProjectAvatar color={project.color} />
                </span>
              </>
            ) : mode === 'list' ? (
              <>
                <span className="flex min-w-0 flex-[2] items-center gap-[8px] overflow-hidden">
                  <ProjectAvatar color={project.color} />
                  <span className="truncate text-[12px] leading-[16px] text-[var(--paper-gray-1)]">
                    {project.name}
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px] text-[var(--paper-gray-2)]">
                  {relativeTime(activityAt)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px] text-[var(--paper-gray-2)]">
                  {relativeTime(project.createdAt)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px] capitalize text-[var(--paper-gray-2)]">
                  {project.state}
                </span>
              </>
            ) : (
              <>
                <ProjectAvatar color={project.color} />
                <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="truncate text-[13px] leading-[16px] text-[var(--paper-gray-1)]">
                    {project.name}
                  </span>
                  <span className="truncate text-[12px] leading-[16px] capitalize text-[var(--paper-gray-3)]">
                    {project.state}
                  </span>
                </span>
                <span className="ml-[12px] w-[104px] shrink-0 text-right text-[12px] leading-[16px] text-[var(--paper-gray-3)]">
                  {relativeTime(activityAt)}
                </span>
              </>
            )}
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ProjectColorMenu
          value={project.color}
          onSelect={(color) =>
            workspace.actions.setProjectColor(project, color)
          }
        />
        <ContextMenuItem variant="destructive" onSelect={remove}>
          Delete project
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function Dashboard({
  workspace,
  all,
  navigate,
  createRequest = 0,
}: {
  readonly workspace: Workspace;
  readonly all: boolean;
  readonly navigate: (path: string) => void;
  readonly createRequest?: number;
}) {
  const [search, setSearch] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const beginCreation = useCallback(() => {
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
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
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

  const open = ({ project }: Entry) => {
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

  const searchField = (
    <label
      className={`group relative flex min-w-0 items-center bg-[var(--paper-ghost-hover)] outline-2 -outline-offset-1 outline-transparent focus-within:outline-[var(--paper-focus)] ${all ? 'h-[32px] rounded-[6px]' : 'h-[36px] rounded-[8px]'}`}
    >
      <SearchIcon
        size={14}
        className="pointer-events-none absolute left-[10px] text-[var(--paper-gray-3)] group-focus-within:text-[var(--paper-gray-1)]"
      />
      <input
        ref={searchInput}
        aria-label="Search projects"
        type="text"
        placeholder="Search projects"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setHighlightedId(null);
        }}
        onKeyDown={onSearchKeyDown}
        className="h-full w-full min-w-0 bg-transparent pl-[28px] pr-[72px] text-[13px] leading-[16px] text-[var(--paper-gray-1)] outline-none placeholder:text-[var(--paper-gray-4)]"
      />
      {!search && (
        <kbd className="pointer-events-none absolute right-[10px] text-[12px] leading-[16px] text-[var(--paper-gray-4)]">
          {/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘F' : 'Ctrl+F'}
        </kbd>
      )}
    </label>
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
        className="h-[26px] rounded-[6px] bg-[#1e1e1e] px-[10px] text-[12px] text-[var(--paper-control)] dark:bg-[#f2f2f2]"
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
          <div className="sticky top-[77px] z-[1] -mx-[8px] my-[1px] flex items-center gap-[16px] bg-[var(--paper-root)] px-[8px] py-[12px] text-[12px] text-[var(--paper-gray-2)]">
            <span className="min-w-0 flex-[2]">Name</span>
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

  if (!all) {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto bg-[var(--paper-root)] text-[var(--paper-gray-1)] [scrollbar-gutter:stable]">
        <div className="flex min-h-full flex-col items-center px-[40px] pb-[60px] pt-[60px]">
          <div className="mt-[28px] flex w-[520px] max-w-full items-center gap-[10px]">
            <button
              type="button"
              className="inline-flex h-[36px] min-w-0 flex-1 items-center justify-between gap-[8px] rounded-[8px] bg-[#1e1e1e] px-[16px] text-[13px] font-medium text-[var(--paper-control)] outline-[var(--paper-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 active:bg-[#333] dark:bg-[#f2f2f2] dark:active:bg-[#d4d4d4]"
              onClick={beginCreation}
            >
              <span>New project</span>
              <kbd className="text-[12px] font-normal opacity-50">
                {/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘N' : 'Ctrl+N'}
              </kbd>
            </button>
            <button
              type="button"
              className="h-[36px] min-w-0 flex-1 rounded-[8px] bg-[var(--paper-control)] px-[16px] text-[13px] font-medium text-[var(--paper-gray-1)] shadow-[var(--paper-shadow-control)] outline-[var(--paper-focus)] focus-visible:outline-2 focus-visible:-outline-offset-1 active:bg-[var(--paper-control-pressed)]"
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
  }

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--paper-panel)] text-[var(--paper-gray-1)]">
      <aside
        className="w-[240px] shrink-0 overflow-y-auto p-[12px]"
        aria-label="Dashboard navigation"
      >
        <div className="flex min-h-full flex-col gap-[24px]">
          <nav className="flex flex-col gap-[2px]">
            <div className="mb-[12px] h-[32px] w-full">{searchField}</div>
            <button
              type="button"
              aria-current="page"
              className="flex h-[32px] items-center gap-[8px] rounded-[6px] bg-[var(--paper-ghost-hover)] px-[8px] text-left text-[13px] text-[var(--paper-gray-1)] outline-[var(--paper-focus)] focus-visible:outline-2"
            >
              <FolderIcon size={15} /> Projects
            </button>
          </nav>
        </div>
      </aside>
      <main
        className="min-w-0 flex-1 overflow-y-auto border-l border-[var(--paper-separator)] bg-[var(--paper-root)] [scrollbar-gutter:stable]"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      >
        <div
          className={`sticky top-0 z-10 border-b bg-[var(--paper-root)] px-[80px] pt-[32px] pb-[12px] max-[900px]:px-[24px] ${scrolled ? 'border-[var(--paper-separator)]' : 'border-transparent'}`}
        >
          <div className="mx-auto flex h-[32px] w-full max-w-[1376px] items-center justify-between gap-[48px]">
            <h1 className="min-w-0 truncate text-[24px] font-medium leading-[32px] tracking-[0.005em]">
              Projects
            </h1>
            <div className="flex h-[28px] shrink-0 items-center gap-[12px]">
              <button
                type="button"
                className="flex h-[28px] items-center gap-[6px] rounded-[6px] bg-[#1e1e1e] px-[12px] text-[12px] font-medium text-[var(--paper-control)] outline-[var(--paper-focus)] focus-visible:outline-2 dark:bg-[#f2f2f2]"
                onClick={beginCreation}
              >
                <PlusIcon size={12} /> New project
              </button>
            </div>
          </div>
        </div>
        <div className="px-[80px] pt-[48px] pb-[32px] max-[900px]:px-[24px]">
          <div className="mx-auto w-full max-w-[1376px]">
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
    </div>
  );
}
