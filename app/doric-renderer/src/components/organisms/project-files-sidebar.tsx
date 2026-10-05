import { DiffView } from '@/components/molecules/diff-view';
import {
  FileTree,
  type FileTreeActions,
} from '@/components/molecules/file-tree';
import { FilesToggle } from '@/components/molecules/files-toggle';
import { ReadFeedback } from '@/components/molecules/read-feedback';
import { WorkspaceCwd } from '@/components/organisms/workspace-cwd';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  changeLetter,
  classifyDiff,
  emptyDirectoryNotice,
  sandboxNotice,
} from '@/domain/files';
import type { Project, Thread } from '@/domain/workspace';
import type { ProjectFiles } from '@/hooks/use-project-files';
import {
  AlertCircleIcon,
  FileDiffIcon,
  FilesIcon,
  FolderIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

type ProjectFilesSidebarProps = {
  /**
   * The Project's sandbox, read by the view that also feeds the file viewer, so
   * the two surfaces share one read of the same file.
   */
  readonly files: ProjectFiles;
  /** Expands or collapses the panel. */
  readonly onToggle: () => void;
  /** The selected Project, whose sandbox this panel reads. */
  readonly project?: Project;
  readonly thread?: Thread;
};

/** The two things the panel can show. */
type PanelView = 'files' | 'changes';

/**
 * The sandbox, as a right-hand panel beside the conversation, rooted at the
 * selected Thread's working directory. It is scoped to that directory rather than
 * to the Project as a whole: the tree starts where the Thread works and the
 * changes view looks at the repository that directory sits in. It reads nothing
 * it does not show, and never writes: the whole tree arrives in one read, the
 * changes view lists that repository's diff, and a file is not shown here —
 * selecting one opens the file viewer panel that sits beside this one, so the
 * tree it was opened from stays where it is.
 *
 * The two views are icon-only tabs in the header in place of a title, because
 * they name what the panel is showing and select it among a set. They wear the
 * line variant: a track and a raised thumb read as a chip borrowed from another
 * surface, while an underline is the panel's own edge carrying the choice. The
 * panel's own toggle closes it, and stays the last control at the corner.
 */
export function ProjectFilesSidebar({
  files,
  onToggle,
  project,
  thread,
}: ProjectFilesSidebarProps) {
  const [view, setView] = useState<PanelView>('files');

  return (
    <Sidebar collapsible="none" className="overflow-hidden">
      <PanelHeader>
        <span role="status" className="truncate text-xs text-muted-foreground">
          {files.refreshing ? 'Updating…' : ''}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
          {/* No colours of their own: the line variant is transparent, and this
              theme's `foreground` is the sidebar's own, so the vendored text
              and underline already sit in the panel's palette. */}
          <Tabs
            className="shrink-0 [app-region:no-drag]"
            value={view}
            onValueChange={(next) =>
              setView(next === 'changes' ? 'changes' : 'files')
            }
          >
            <TabsList variant="line">
              <TabsTrigger aria-label="Files" value="files">
                <FilesIcon />
              </TabsTrigger>
              <TabsTrigger aria-label="Changes" value="changes">
                <FileDiffIcon />
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <FilesToggle onToggle={onToggle} open />
        </div>
      </PanelHeader>
      <SidebarContent className="overflow-hidden p-0">
        <SidebarGroup className="h-full min-h-0 p-0">
          <SidebarGroupContent className="flex min-h-0 w-full flex-1 flex-col">
            <ReadFeedback
              error={
                files.treeError ??
                (view === 'changes' ? files.changesError : undefined)
              }
              refreshing={files.refreshing}
              onRetry={files.actions.refresh}
            />
            <SandboxGate files={files} project={project}>
              {view === 'files' ? (
                <FilesView files={files} />
              ) : (
                <ChangesView files={files} />
              )}
            </SandboxGate>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <FilesFooter thread={thread} />
    </Sidebar>
  );
}

/**
 * The panel's header strip: the drag region, its boundary, and the controls it
 * carries — the view tabs and the panel's own toggle, together at the right
 * corner.
 */
function PanelHeader({ children }: { readonly children: ReactNode }) {
  return (
    <div
      data-slot="project-files-header"
      className="relative flex chrome-bar shrink-0 items-center bg-sidebar pl-2 [app-region:drag]"
    >
      <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
      {children}
    </div>
  );
}

/**
 * What the panel shows when the sandbox itself cannot be read. Both views share
 * one answer, because a queued, failed or terminated Project has no files and no
 * changes: the surface explains the Project instead of failing a view at a time.
 * One tree read settles both what the sandbox holds and whether it is readable.
 */
function SandboxGate({
  children,
  files,
  project,
}: {
  readonly children: ReactNode;
  readonly files: ProjectFiles;
  readonly project?: Project;
}) {
  const { tree } = files;

  if (project === undefined) {
    return (
      <PanelState
        description="Select a project to see its sandbox."
        title="No project selected"
      />
    );
  }
  if (tree.status === 'idle' || tree.status === 'loading') {
    // A Project with no sandbox read yet is answered above, so this is a read
    // on its way — and the error, when there is one, is what failed it.
    if (files.treeError !== undefined) {
      return (
        <PanelState
          description="The sandbox could not be read. Try again using the action above."
          icon={<AlertCircleIcon />}
          title="Unable to read the sandbox"
        />
      );
    }
    return <MenuSkeleton />;
  }
  if (tree.status !== 'ready') {
    return (
      <PanelState
        description={sandboxNotice(tree.status, tree.retryAfterSeconds)}
        title="No files to show"
      />
    );
  }

  return children;
}

/** The selected Thread's working directory and Git status. */
function FilesFooter({ thread }: { readonly thread?: Thread }) {
  return (
    <footer
      data-slot="project-files-footer"
      className="flex chrome-bar shrink-0 items-center gap-2 border-t px-3"
    >
      <WorkspaceCwd thread={thread} />
    </footer>
  );
}

/**
 * The directory tree, read whole. A file row selects, which opens the file viewer
 * beside this panel rather than replacing the tree, so what was opened stays
 * reachable.
 */
function FilesView({ files }: { readonly files: ProjectFiles }) {
  const { actions, selectedPath, tree } = files;
  const treeActions: FileTreeActions = {
    open: actions.openFile,
    toggle: actions.toggleDirectory,
  };

  const entries = tree.status === 'ready' ? tree.value : [];
  if (entries.length === 0) {
    return <PanelState description={emptyDirectoryNotice} title="No files" />;
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <SidebarMenu role="tree" className="w-full gap-0 py-1">
        <FileTree
          actions={treeActions}
          depth={0}
          entries={entries}
          expanded={files.expanded}
          selectedPath={selectedPath}
        />
      </SidebarMenu>
    </ScrollArea>
  );
}

/** The changed files, grouped by repository, each under its own sticky header. */
function ChangesView({ files }: { readonly files: ProjectFiles }) {
  const { actions, changes } = files;
  const { hideChanges, loadChanges } = actions;

  // The diff is read when the changes view is first shown, never before: the
  // hook is told to read it by the surface that asks for it.
  useEffect(() => {
    loadChanges();
    return hideChanges;
  }, [hideChanges, loadChanges]);

  const repositories = useMemo(
    () =>
      changes.status === 'ready'
        ? changes.value.repositories.map((repository) => ({
            path: repository.path,
            changes: repository.changes,
            files: classifyDiff(repository.diff),
          }))
        : [],
    [changes],
  );

  if (changes.status === 'idle') {
    return (
      <PanelState
        description={
          files.changesError === undefined
            ? 'The changes have not been read yet.'
            : 'The changes could not be read. Try again using the action above.'
        }
        title={
          files.changesError === undefined
            ? 'No changes read'
            : 'Unable to read changes'
        }
      />
    );
  }
  if (changes.status === 'loading') return <ContentSkeleton />;
  if (changes.status !== 'ready') {
    return (
      <PanelState
        description={sandboxNotice(changes.status, changes.retryAfterSeconds)}
        title="The changes cannot be read"
      />
    );
  }
  if (repositories.length === 0) {
    return (
      <PanelState
        description="This directory holds no git repository."
        title="No repositories"
      />
    );
  }

  const changed = repositories.filter(
    (repository) => repository.changes.length > 0,
  );
  if (changed.length === 0) {
    return (
      <PanelState
        description="This workspace has no uncommitted changes."
        title="No changes"
      />
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex min-w-0 flex-col">
        {changed.map((repository) => (
          <section key={repository.path} className="flex flex-col">
            <h3 className="sticky top-0 z-10 border-y bg-sidebar px-3 py-1.5 font-mono text-xs">
              {repository.path === '' ? '.' : repository.path}
            </h3>
            <SidebarMenu className="w-full gap-0 py-1">
              {repository.changes.map((change) => (
                <SidebarMenuItem key={change.path} className="w-full">
                  <SidebarMenuButton
                    asChild
                    size="sm"
                    className="h-7 w-full rounded-none px-3 pr-8"
                  >
                    <div>
                      <span className="truncate font-mono">{change.path}</span>
                    </div>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>
                    {changeLetter(change.status)}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            <DiffView files={repository.files} />
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}

/** A state with nothing to show, said in one sentence. */
function PanelState({
  description,
  icon,
  title,
}: {
  readonly description: string;
  readonly icon?: ReactNode;
  readonly title: string;
}) {
  return (
    <Empty className="p-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <FolderIcon />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Rows in the shape of the tree, while the first listing is on its way. */
function MenuSkeleton() {
  return (
    <SidebarMenu className="w-full gap-0 py-1">
      {Array.from({ length: 6 }, (_, index) => (
        <SidebarMenuItem key={index}>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

/** Lines, while a file or a diff is on its way. */
function ContentSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-3 w-full" />
      ))}
    </div>
  );
}
