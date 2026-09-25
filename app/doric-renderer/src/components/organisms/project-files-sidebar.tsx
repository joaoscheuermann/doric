import { DiffView } from '@/components/molecules/diff-view';
import { FileContent } from '@/components/molecules/file-content';
import {
  FileTree,
  type FileTreeActions,
} from '@/components/molecules/file-tree';
import { FilesToggle } from '@/components/molecules/files-toggle';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Toggle } from '@/components/ui/toggle';
import {
  baseName,
  changeLetter,
  classifyDiff,
  collapsedPath,
  emptyDirectoryNotice,
  parentPath,
  ROOT_PATH,
  sandboxNotice,
} from '@/domain/files';
import type { Project, ProjectFileContent } from '@/domain/workspace';
import {
  type ProjectFiles,
  type ReadState,
  useProjectFiles,
} from '@/hooks/use-project-files';
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  FileDiffIcon,
  FilesIcon,
  FolderIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';

type ProjectFilesSidebarProps = {
  /** Expands or collapses the panel. */
  readonly onToggle: () => void;
  /**
   * Whether the panel is expanded. A closed panel is not mounted: the layout
   * draws this surface only while it is open, and carries the control that
   * reopens it in the main header.
   */
  readonly open: boolean;
  /** The selected Project, whose sandbox this panel reads. */
  readonly project?: Project;
  /** Grows whenever the agent writes to the sandbox. */
  readonly revision: number;
};

/** The two things the panel can show. */
type PanelView = 'files' | 'changes';

/**
 * The Project's sandbox, as a right-hand panel beside the conversation. It is
 * scoped to the Project, not to the selected Thread, reads nothing it does not
 * show, and never writes: the tree opens directories on demand, a file opens in
 * place of the tree, and the changes view lists the workspace diff.
 *
 * The two views are icon-only toggles in the header in place of a title, because
 * they name what the panel is showing and select it, and an open file puts a
 * back control and the file's own name at the header's left, which returns to
 * the tree the file was opened from; the footer carries the directory the file
 * sits in — the file itself is named above, so the chain stops at its directory
 * — and the one action the surface has. The panel's own toggle closes it, and
 * stays the last control at the header's corner.
 */
export function ProjectFilesSidebar({
  onToggle,
  open,
  project,
  revision,
}: ProjectFilesSidebarProps) {
  // A closed panel reads nothing: with no Project the hook stays idle.
  const files = useProjectFiles({
    projectId: open ? project?.id : undefined,
    revision,
  });
  const [view, setView] = useState<PanelView>('files');

  return (
    <Sidebar collapsible="none" className="overflow-hidden">
      <PanelHeader>
        {view === 'files' && files.selectedPath !== undefined && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to files"
              className="shrink-0 [app-region:no-drag]"
              onClick={files.actions.closeFile}
            >
              <ArrowLeftIcon />
            </Button>
            <span className="min-w-0 truncate font-mono text-xs">
              {baseName(files.selectedPath)}
            </span>
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
          <ViewToggle
            icon={<FilesIcon />}
            label="Files"
            onSelect={() => setView('files')}
            selected={view === 'files'}
          />
          <ViewToggle
            icon={<FileDiffIcon />}
            label="Changes"
            onSelect={() => setView('changes')}
            selected={view === 'changes'}
          />
          <FilesToggle onToggle={onToggle} open />
        </div>
      </PanelHeader>
      <SidebarContent className="overflow-hidden p-0">
        <SidebarGroup className="h-full min-h-0 p-0">
          <SidebarGroupContent className="flex min-h-0 w-full flex-1 flex-col">
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
      <FilesFooter files={files} />
    </Sidebar>
  );
}

/**
 * One of the panel's two views, as an icon-only toggle sized for the h-8 header:
 * the `sm` toggle with its horizontal padding dropped is the icon-sized one.
 *
 * The view on screen is the highlighted one. The vendored Toggle supplies the
 * pressed background; recolouring its pressed state to the sidebar's own accent,
 * and the icon to that accent's foreground, is what makes an active view read as
 * part of the panel rather than as a chip in another palette. Unselected, the
 * icon stays muted.
 *
 * Pressing the view already on screen selects it again rather than clearing it,
 * because the panel always shows one of the two.
 */
function ViewToggle({
  icon,
  label,
  onSelect,
  selected,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onSelect: () => void;
  readonly selected: boolean;
}) {
  return (
    <Toggle
      aria-label={label}
      size="sm"
      className="shrink-0 px-0! text-muted-foreground data-[state=on]:bg-sidebar-accent! data-[state=on]:text-sidebar-accent-foreground! [app-region:no-drag]"
      pressed={selected}
      onPressedChange={onSelect}
    >
      {icon}
    </Toggle>
  );
}

/**
 * The panel's header strip: the drag region, its boundary, and the controls it
 * carries — the two view toggles and the panel's own toggle, together at the
 * right corner.
 */
function PanelHeader({ children }: { readonly children: ReactNode }) {
  return (
    <div
      data-slot="project-files-header"
      className="relative flex h-8 shrink-0 items-center bg-sidebar pl-2 [app-region:drag]"
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
  if (project === undefined) {
    return (
      <PanelState
        description="Select a project to see its sandbox."
        title="No project selected"
      />
    );
  }
  if (files.sandbox.status === 'idle' || files.sandbox.status === 'loading') {
    // A Project with no sandbox read yet is answered above, so this is a read
    // on its way — and the error, when there is one, is what failed it.
    if (files.error !== undefined) {
      return (
        <PanelState
          description={files.error}
          icon={<AlertCircleIcon />}
          title="Unable to read the sandbox"
        />
      );
    }
    return <MenuSkeleton />;
  }
  if (files.sandbox.status !== 'ready') {
    return (
      <PanelState
        description={sandboxNotice(
          files.sandbox.status,
          files.sandbox.retryAfterSeconds,
        )}
        title="No files to show"
      />
    );
  }

  return (
    <>
      {files.error !== undefined && (
        <Alert variant="destructive" className="mx-2 my-1 w-auto shrink-0">
          <AlertCircleIcon />
          <AlertTitle>Unable to read</AlertTitle>
          <AlertDescription>{files.error}</AlertDescription>
        </Alert>
      )}
      {children}
    </>
  );
}

/**
 * The panel's footer: the directory the open file sits in, and the one action the
 * surface has, since a read-only view has nothing to submit. The file's own name
 * is the header's business, so this chain stops at its directory; every crumb
 * returns to the tree, where the directory it selects is already open, because
 * the file was reached through it.
 */
function FilesFooter({ files }: { readonly files: ProjectFiles }) {
  const { actions, selectedPath } = files;

  return (
    <footer
      data-slot="project-files-footer"
      className="flex h-8 shrink-0 items-center gap-2 border-t px-3"
    >
      <FileBreadcrumb
        onBack={actions.closeFile}
        path={parentPath(selectedPath ?? ROOT_PATH)}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh files"
        disabled={files.sandbox.status !== 'ready'}
        className="ml-auto shrink-0"
        onClick={actions.refresh}
      >
        <RefreshCwIcon />
      </Button>
    </footer>
  );
}

/** The directory tree, or the open file in its place; the footer names the path. */
function FilesView({ files }: { readonly files: ProjectFiles }) {
  const { actions, selectedPath } = files;
  const treeActions: FileTreeActions = {
    open: actions.openFile,
    toggle: actions.toggleDirectory,
  };

  if (selectedPath !== undefined) {
    return <FileBody file={files.file} />;
  }

  const entries = files.listings[ROOT_PATH];
  if (entries === undefined || entries.length === 0) {
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
          listings={files.listings}
          loading={files.loading}
          selectedPath={selectedPath}
        />
      </SidebarMenu>
    </ScrollArea>
  );
}

/**
 * The open file's content, or what the surface is waiting for instead. The file's
 * path and byte size belong to the footer, so this is only the text.
 */
function FileBody({ file }: { readonly file: ReadState<ProjectFileContent> }) {
  if (file.status === 'ready') return <FileContent file={file.value} />;
  if (file.status === 'idle' || file.status === 'loading')
    return <ContentSkeleton />;
  return (
    <PanelState
      description={sandboxNotice(file.status, file.retryAfterSeconds)}
      title="This file cannot be shown"
    />
  );
}

/**
 * The chain from the workspace root to the open file, or just the workspace root
 * when no file is open. It lives in the footer so the reading column keeps its
 * full height, and a chain too deep for that row puts its middle behind one
 * trigger instead of clipping it: the rule that decides what collapses is
 * `domain/files.ts`'s `collapsedPath`. Every crumb above the file returns to the
 * tree, where the directory it selects is already open, because the file was
 * reached through it; the last crumb is the file itself, and it truncates when
 * it alone is wider than the row.
 */
function FileBreadcrumb({
  onBack,
  path,
}: {
  readonly onBack: () => void;
  readonly path: string;
}) {
  const { hidden, leading, trailing } = collapsedPath(path);
  const crumbs = [leading, ...trailing];

  return (
    <Breadcrumb className="min-w-0 overflow-hidden">
      <BreadcrumbList className="flex-nowrap gap-1 text-xs">
        <BreadcrumbItem className="shrink-0">
          <BreadcrumbLink asChild>
            <button type="button" className="font-mono" onClick={onBack}>
              {leading.name}
            </button>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {hidden.length > 0 && (
          <>
            <BreadcrumbSeparator className="shrink-0" />
            <BreadcrumbItem className="shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Show the hidden path"
                  className="flex items-center gap-1"
                >
                  <BreadcrumbEllipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {hidden.map((segment) => (
                    <DropdownMenuItem
                      key={segment.path}
                      className="font-mono"
                      onSelect={onBack}
                    >
                      {segment.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
          </>
        )}
        {crumbs.slice(1).map((segment, index, shown) => {
          const last = index === shown.length - 1;
          return (
            <Fragment key={segment.path}>
              <BreadcrumbSeparator className="shrink-0" />
              <BreadcrumbItem className={last ? 'min-w-0' : 'shrink-0'}>
                {last ? (
                  <BreadcrumbPage className="min-w-0 truncate font-mono">
                    {segment.name}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      className="font-mono"
                      onClick={onBack}
                    >
                      {segment.name}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** The changed files, then the diff they add up to. */
function ChangesView({ files }: { readonly files: ProjectFiles }) {
  const { actions, changes } = files;
  const { loadChanges } = actions;

  // The diff is read when the changes view is first shown, never before: the
  // hook is told to read it by the surface that asks for it.
  useEffect(() => {
    loadChanges();
  }, [loadChanges]);

  const classified = useMemo(
    () => (changes.status === 'ready' ? classifyDiff(changes.value) : []),
    [changes],
  );

  if (changes.status === 'idle') {
    return (
      <PanelState
        description="The changes have not been read yet."
        title="No changes read"
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
  if (!changes.value.repository) {
    return (
      <PanelState
        description="This workspace is not a git repository."
        title="No repository"
      />
    );
  }
  if (changes.value.changes.length === 0) {
    return (
      <PanelState
        description="This workspace has no uncommitted changes."
        title="No changes"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="max-h-48 shrink-0">
        <SidebarMenu className="w-full gap-0 py-1">
          {changes.value.changes.map((change) => (
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
              <SidebarMenuBadge>{changeLetter(change.status)}</SidebarMenuBadge>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </ScrollArea>
      <ScrollArea className="min-h-0 flex-1">
        <DiffView files={classified} />
      </ScrollArea>
    </div>
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
