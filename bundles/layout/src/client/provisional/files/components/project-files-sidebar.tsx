import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from 'desktop-ui/empty';
import { ScrollArea } from 'desktop-ui/scroll-area';
import { SidebarMenu } from 'desktop-ui/sidebar';
import {
  ChangeCounts,
  FileTree,
  type FileTreeActions,
  ReadFeedback,
  TreeSkeleton,
} from 'desktop-ui/workspace';
import { FileDiffIcon, FilesIcon, FolderIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { PanelBuiltIn } from '../../../components/organisms/project-panel.js';
import type { Project } from '../../../domain/workspace.js';
import {
  changeDecorations,
  changedLineTotals,
  changedRepositories,
} from '../domain/change-tree.js';
import { emptyDirectoryNotice, sandboxNotice } from '../domain/files.js';
import type { ProjectChange } from '../domain/project-files.js';
import type { ProjectFiles } from '../hooks/use-project-files.js';
import { ChangesTree } from './changes-tree.js';

type ProjectFilesContentProps = {
  /**
   * The Project's sandbox, read by the view that also feeds the file viewer, so
   * the two surfaces share one read of the same file.
   */
  readonly files: ProjectFiles;
  /** The selected Project, whose sandbox this panel reads. */
  readonly project?: Project;
  readonly view: PanelView;
  readonly onOpenChange: (repository: string, change: ProjectChange) => void;
  readonly selectedChangePath?: string;
};

/** The two things the panel can show. */
export type PanelView = 'files' | 'changes';

/**
 * The provisional Files and Changes views of the Project panel (WP-10P): the
 * built-in entries of the layout's "Project views" strip until the files and
 * Git bundles own them (10N).
 */
export const provisionalPanelViews = (
  files: ProjectFiles,
): readonly PanelBuiltIn[] => [
  { id: 'files', label: 'Files', icon: <FilesIcon /> },
  {
    id: 'changes',
    label: 'Changes',
    icon: <FileDiffIcon />,
    badge:
      files.changes.status === 'ready' ? (
        <ChangeCounts
          {...changedLineTotals(files.changes.value.repositories)}
        />
      ) : undefined,
  },
];

/**
 * The sandbox, rooted at the selected Thread's working directory. It is
 * scoped to that directory rather than to the Project as a whole: the tree
 * starts where the Thread works and the changes view looks at the repository
 * that directory sits in. It reads nothing it does not show, and never
 * writes: the whole tree arrives in one read, the changes view lists
 * repositories and their changed paths, and a file is not shown here —
 * selecting one opens the file viewer panel that sits beside this one, so the
 * tree it was opened from stays where it is. The frame around it (the view
 * tabs, the toggle and the footer) is the layout's `ProjectPanel`.
 */
export function ProjectFilesContent({
  files,
  project,
  view,
  onOpenChange,
  selectedChangePath,
}: ProjectFilesContentProps) {
  return (
    <>
      <ReadFeedback
        error={files.treeError ?? files.changesError}
        refreshing={files.refreshing}
        onRetry={files.actions.refresh}
      />
      <SandboxGate files={files} project={project} changes={view === 'changes'}>
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
    </>
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
