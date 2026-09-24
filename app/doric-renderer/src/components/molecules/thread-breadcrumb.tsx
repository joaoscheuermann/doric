import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import type { Project, Thread } from '@/domain/workspace';
import { FolderIcon, type LucideIcon, MessageSquareIcon } from 'lucide-react';
import { Fragment } from 'react';

type ThreadBreadcrumbProps = {
  readonly onSelectProject: (project: Project) => void;
  readonly onSelectThread: (thread: Thread) => void;
  /** The chain from the outermost Thread down to the selected one. */
  readonly path: readonly Thread[];
  readonly project?: Project;
};

/** A crumb's mark and name: the icon says Project or Thread, the name truncates. */
function CrumbLabel({
  icon: Icon,
  name,
}: {
  readonly icon: LucideIcon;
  readonly name: string;
}) {
  return (
    <>
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </>
  );
}

/**
 * The selected Thread named by where it sits: its Project, then each ancestor
 * Thread, ending on the Thread itself. Every part but the last selects what it
 * names, so the path doubles as navigation; with no Thread selected the Project
 * is the last part. Each crumb carries the mark the sidebar gives its kind. It
 * derives nothing — the Project and the path arrive whole through props.
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
                <CrumbLabel icon={FolderIcon} name={project.name} />
              </BreadcrumbPage>
            </BreadcrumbItem>
          ) : (
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <button
                  type="button"
                  onClick={() => onSelectProject(project)}
                  className="flex max-w-48 items-center gap-2"
                >
                  <CrumbLabel icon={FolderIcon} name={project.name} />
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
          ))}
        {ancestors.map((thread) => (
          <Fragment key={thread.id}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <button
                  type="button"
                  onClick={() => onSelectThread(thread)}
                  className="flex max-w-48 items-center gap-2"
                >
                  <CrumbLabel icon={MessageSquareIcon} name={thread.name} />
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
        {current !== undefined && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="flex max-w-48 items-center gap-2">
                <CrumbLabel icon={MessageSquareIcon} name={current.name} />
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
