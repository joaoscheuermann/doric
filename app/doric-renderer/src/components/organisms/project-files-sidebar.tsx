import { FileDiffIcon, FilesIcon, FolderIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { ChangeCounts } from '@/components/molecules/change-counts';
import { ChangesTree } from '@/components/molecules/changes-tree';
import {
  FileTree,
  type FileTreeActions,
} from '@/components/molecules/file-tree';
import { FilesToggle } from '@/components/molecules/files-toggle';
import { ReadFeedback } from '@/components/molecules/read-feedback';
import { TabStrip } from '@/components/molecules/tab-strip';
import { TreeSkeleton } from '@/components/molecules/tree-skeleton';
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
} from '@/components/ui/sidebar';
import { Tabs } from '@/components/ui/tabs';
import {
  changeDecorations,
  changedLineTotals,
  changedRepositories,
} from '@/domain/change-tree';
import { emptyDirectoryNotice, sandboxNotice } from '@/domain/files';
import type { Project, ProjectChange } from '@/domain/workspace';
import type { ProjectFiles } from '@/hooks/use-project-files';
import { moveItem } from '@/utility/move-item';

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
  readonly view: PanelView;
  readonly onViewChange: (view: PanelView) => void;
  readonly onOpenChange: (repository: string, change: ProjectChange) => void;
  readonly selectedChangePath?: string;
};

/** The two things the panel can show. */
export type PanelView = 'files' | 'changes';

/**
 * The sandbox, as a right-hand panel beside the conversation, rooted at the
 * selected Thread's working directory. It is scoped to that directory rather than
 * to the Project as a whole: the tree starts where the Thread works and the
 * changes view looks at the repository that directory sits in. It reads nothing
 * it does not show, and never writes: the whole tree arrives in one read, the
 * changes view lists repositories and their changed paths, and a file is not shown here —
 * selecting one opens the file viewer panel that sits beside this one, so the
 * tree it was opened from stays where it is.
 *
 * The two views are icon-only tabs in the header in place of a title, because
 * they name what the panel is showing and select it among a set. The
 * panel's own toggle closes it, and stays the last control at the corner.
 */
export function ProjectFilesSidebar({
  files,
  onToggle,
  project,
  view,
  onViewChange,
  onOpenChange,
  selectedChangePath,
}: ProjectFilesSidebarProps) {
  const [order, setOrder] = useState<readonly string[]>(['files', 'changes']);

  return (
    <Sidebar collapsible="none" className="overflow-hidden">
      <PanelHeader>
        <div className="ml-auto flex min-w-0 items-center gap-1 pr-2">
          <Tabs
            className="min-w-0 [app-region:no-drag]"
            value={view}
            onValueChange={(next) =>
              onViewChange(next === 'changes' ? 'changes' : 'files')
            }
          >
            <TabStrip
              label="Project views"
              selected={view}
              onMove={(from, to) =>
                setOrder((current) =>
                  moveItem(current, current.indexOf(from), current.indexOf(to)),
                )
              }
              items={order.map((id) => ({
                id,
                label: id === 'files' ? 'Files' : 'Changes',
                icon: id === 'files' ? <FilesIcon /> : <FileDiffIcon />,
                iconOnly: true,
                badge:
                  id === 'changes' && files.changes.status === 'ready' ? (
                    <ChangeCounts
                      {...changedLineTotals(files.changes.value.repositories)}
                    />
                  ) : undefined,
              }))}
            />
          </Tabs>
          <FilesToggle onToggle={onToggle} open />
        </div>
      </PanelHeader>
      <SidebarContent className="overflow-hidden p-0">
        <SidebarGroup className="h-full min-h-0 p-0">
          <SidebarGroupContent className="flex min-h-0 w-full flex-1 flex-col">
            <ReadFeedback
              error={files.treeError ?? files.changesError}
              refreshing={files.refreshing}
              onRetry={files.actions.refresh}
            />
            <SandboxGate
              files={files}
              project={project}
              changes={view === 'changes'}
            >
              {view === 'files' ? (
                <FilesView files={files} />
              ) : (
                <ChangesView
                  files={files}
                  onOpenChange={onOpenChange}
                  selectedPath={selectedChangePath}
                />
              )}
            </SandboxGate>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <footer
        aria-hidden="true"
        data-slot="project-files-footer"
        className="chrome-bar shrink-0 border-t bg-sidebar"
      />
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
  changes,
}: {
  readonly children: ReactNode;
  readonly files: ProjectFiles;
  readonly project?: Project;
  readonly changes: boolean;
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
      return null;
    }
    return <TreeSkeleton changes={changes} />;
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
          decorations={changeDecorations(
            files.changes.status === 'ready'
              ? files.changes.value.repositories
              : [],
          )}
        />
      </SidebarMenu>
    </ScrollArea>
  );
}

/** Changed paths grouped by repository; selecting a row opens its comparison. */
function ChangesView({
  files,
  onOpenChange,
  selectedPath,
}: {
  readonly files: ProjectFiles;
  readonly onOpenChange: (repository: string, change: ProjectChange) => void;
  readonly selectedPath?: string;
}) {
  const { actions, changes } = files;
  const repositories =
    changes.status === 'ready' ? changes.value.repositories : [];

  if (changes.status === 'idle') {
    if (files.changesError !== undefined) return null;
    return (
      <PanelState
        description="The changes have not been read yet."
        title="No changes read"
      />
    );
  }
  if (changes.status === 'loading') return <TreeSkeleton changes />;
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

  const changed = changedRepositories(repositories);
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
      <SidebarMenu role="tree" className="w-full gap-0 py-1">
        {changed.map((repository) => (
          <ChangesTree
            key={repository.path}
            repository={repository}
            collapsed={files.changesCollapsed}
            selectedPath={selectedPath}
            onToggle={actions.toggleChangesDirectory}
            onOpen={onOpenChange}
          />
        ))}
      </SidebarMenu>
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
