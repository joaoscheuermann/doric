import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from 'desktop/ui/breadcrumb';
import { Fragment, type ReactNode } from 'react';

import { threadKind } from '../../domain/thread-kind.js';
import type { Project, Thread } from '../../domain/workspace.js';
import { ProjectAvatar } from './project-avatar.js';
import { ThreadKindIcon } from './thread-mark.js';

type ThreadBreadcrumbProps = {
  readonly onSelectProject: (project: Project) => void;
  readonly onSelectThread: (thread: Thread) => void;
  /** The chain from the outermost Thread down to the selected one. */
  readonly path: readonly Thread[];
  readonly project?: Project;
};

/**
 * A crumb's mark and name. The mark carries the color or the kind; the name is
 * the part that truncates when the path runs long.
 */
function CrumbLabel({
  mark,
  name,
}: {
  readonly mark: ReactNode;
  readonly name: string;
}) {
  return (
    <>
      {mark}
      <span className="truncate">{name}</span>
    </>
  );
}

/**
 * A Thread's mark: the one its sidebar row leads with. A main Thread keeps the
 * bubble; a sub-thread wears the bubble with the plus that opened it, and an
 * agent Thread the bot that owns it, so the crumb already says what the reader
 * may do here.
 */
function ThreadMark({ thread }: { readonly thread: Thread }) {
  return <ThreadKindIcon kind={threadKind(thread)} />;
}

/**
 * The selected Thread named by where it sits: its Project, then each ancestor
 * Thread, ending on the Thread itself. Every part but the last selects what it
 * names, so the path doubles as navigation; with no Thread selected the Project
 * is the last part. Each crumb carries the mark the sidebar gives its kind: a
 * Project shows its color, a Thread its bubble. It derives nothing — the Project
 * and the path arrive whole through props.
 */
export function ThreadBreadcrumb({
  onSelectProject,
  onSelectThread,
  path,
  project,
}: ThreadBreadcrumbProps) {
  const current = path[path.length - 1];
  const ancestors = path.slice(0, -1);

  if (project === undefined && current === undefined) return null;

  return (
    <Breadcrumb className="min-w-0 [app-region:no-drag]">
      <BreadcrumbList className="flex-nowrap text-xs">
        {project !== undefined &&
          (current === undefined ? (
            <BreadcrumbItem>
              <BreadcrumbPage className="flex max-w-48 items-center gap-2">
                <CrumbLabel
                  mark={<ProjectAvatar color={project.color} />}
                  name={project.name}
                />
              </BreadcrumbPage>
            </BreadcrumbItem>
          ) : (
            <BreadcrumbItem>
              <BreadcrumbLink
                render={
                  <button
                    type="button"
                    onClick={() => onSelectProject(project)}
                    className="flex max-w-48 items-center gap-2"
                  />
                }
              >
                <CrumbLabel
                  mark={<ProjectAvatar color={project.color} />}
                  name={project.name}
                />
              </BreadcrumbLink>
            </BreadcrumbItem>
          ))}
        {ancestors.map((thread) => (
          <Fragment key={thread.id}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink
                render={
                  <button
                    type="button"
                    onClick={() => onSelectThread(thread)}
                    className="flex max-w-48 items-center gap-2"
                  />
                }
              >
                <CrumbLabel
                  mark={<ThreadMark thread={thread} />}
                  name={thread.name}
                />
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
        {current !== undefined && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="flex max-w-48 items-center gap-2">
                <CrumbLabel
                  mark={<ThreadMark thread={current} />}
                  name={current.name}
                />
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
