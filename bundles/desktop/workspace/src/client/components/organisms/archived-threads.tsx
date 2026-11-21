import { SidebarMenuItem } from 'desktop/ui/sidebar';
import { Fragment } from 'react';

import { archivedSections } from '../../domain/thread-archive.js';
import { filterThreadTree } from '../../domain/thread-filter.js';
import { type ThreadActivity, threadLevel } from '../../domain/thread-tree.js';
import type { Thread } from '../../domain/workspace.js';
import {
  ThreadBranches,
  type ThreadBranchesActions,
} from '../molecules/thread-branches.js';

const NOTICE = 'px-2.5 py-1 text-[13px] leading-[19.5px] text-muted-foreground';

type ArchivedThreadsProps = {
  readonly actions: ThreadBranchesActions;
  readonly activity: ReadonlyMap<string, ThreadActivity>;
  readonly collapsed: ReadonlySet<string>;
  readonly onExpand: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly projectId: string;
  /** The sidebar's search; '' draws every section whole. */
  readonly query: string;
  readonly selectedThreadId?: string;
  /** Every Thread of the Project, in host order. */
  readonly threads: readonly Thread[];
};

/**
 * The Archived tab's rows (docs/designs/thread-archive.md §10.4): per section
 * of `archivedSections`, a header row and the section's tree, filtered by the
 * search; "No archived threads" without an archived Thread and a query, "No
 * threads match" when the query matches nothing. Sections are computed at
 * render time.
 */
export function ArchivedThreads({
  actions,
  activity,
  collapsed,
  onExpand,
  onToggle,
  projectId,
  query,
  selectedThreadId,
  threads,
}: ArchivedThreadsProps) {
  const sections = archivedSections(threads, new Date()).map((section) => {
    const level = threadLevel(section.threads, undefined, projectId);
    const filter =
      query === '' ? undefined : filterThreadTree(level.nodes, query);
    return { section, level, filter };
  });
  const shown = sections.filter(
    ({ filter }) => filter === undefined || filter.shown.size > 0,
  );
  return (
    <>
      {shown.map(({ section, level, filter }) => (
        <Fragment key={section.id}>
          <SidebarMenuItem
            role="presentation"
            className="flex h-[31px] items-center px-2.5 text-xs text-muted-foreground"
          >
            {section.label}
          </SidebarMenuItem>
          <ThreadBranches
            actions={actions}
            activity={activity}
            collapsed={collapsed}
            context={section.context}
            depth={0}
            {...(filter === undefined ? {} : { filter })}
            level={level}
            mode="archived"
            onExpand={onExpand}
            onToggle={onToggle}
            selectedThreadId={selectedThreadId}
          />
        </Fragment>
      ))}
      {sections.length === 0 && query === '' && (
        <SidebarMenuItem data-threads-empty="" className={NOTICE}>
          No archived threads
        </SidebarMenuItem>
      )}
      {shown.length === 0 && query !== '' && (
        <SidebarMenuItem data-threads-empty="" className={NOTICE}>
          No threads match
        </SidebarMenuItem>
      )}
    </>
  );
}
