import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';

import type { api } from '../../api/workspace-api.js';
import type { Workspace } from '../../hooks/use-workspace.js';
import { ProjectAvatar } from './project-avatar.js';
import { ProjectColorMenu } from './project-color-menu.js';

/** One row of the Projects activity read: a Project and when it was last active. */
export type ProjectEntry = Awaited<
  ReturnType<typeof api.projects.activity>
>[number];

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

/**
 * One Project in the Dashboard's lists, with the context menu that recolours
 * or deletes it. `mode` picks the drawing: `'recent'` (the home body),
 * `'list'` (the `/projects` table row) or `'grid'` (a card). The element
 * carries `data-project-id`, which the search's arrow keys scroll to.
 * Pressing it calls `onOpen(entry)` once. `highlighted` draws the search's
 * current match. Moved verbatim from `dashboard.tsx:34-157`, together with
 * its private `relativeTime`; nothing it draws changes.
 */
export function ProjectItem({
  entry,
  mode,
  highlighted,
  workspace,
  onOpen,
}: {
  readonly entry: ProjectEntry;
  readonly mode: 'recent' | 'grid' | 'list';
  readonly highlighted: boolean;
  readonly workspace: Workspace;
  readonly onOpen: (entry: ProjectEntry) => void;
}) {
  const { project, activityAt } = entry;
  const remove = () =>
    workspace.actions.requestDelete({ kind: 'project', value: project });
  const isGrid = mode === 'grid';

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            data-project-id={project.id}
            className={
              isGrid
                ? `group relative min-w-0 overflow-hidden rounded-[8px] bg-[var(--paper-control)] outline -outline-offset-1 dark:bg-[var(--paper-panel)] ${highlighted ? 'outline-2 outline-[var(--paper-focus)]' : 'outline-1 outline-black/5 dark:outline-white/5'}`
                : `group relative -mx-[8px] flex min-w-0 items-center rounded-[6px] p-[8px] hover:bg-[var(--paper-ghost-hover)] ${highlighted ? 'bg-[var(--paper-thumbnail-selected)] outline outline-2 -outline-offset-2 outline-[var(--paper-focus)]' : ''}`
            }
          />
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ProjectColorMenu
          value={project.color}
          onSelect={(color) =>
            workspace.actions.setProjectColor(project, color)
          }
        />
        <ContextMenuItem variant="destructive" onClick={remove}>
          Delete project
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
