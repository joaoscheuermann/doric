import { DiffView } from '@/components/molecules/diff-view';
import { FileContent } from '@/components/molecules/file-content';
import {
  FileTree,
  type FileTreeActions,
} from '@/components/molecules/file-tree';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  changeLetter,
  classifyDiff,
  collapsedPath,
  emptyDirectoryNotice,
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
  FileDiffIcon,
  FilesIcon,
  FolderIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';

type ProjectFilesSidebarProps = {
  /** Expands or collapses the panel. */
  readonly onToggle: () => void;
  /** Whether the panel is expanded; collapsed it keeps only its own toggle. */
  readonly open: boolean;
  /** The selected Project, whose sandbox this panel reads. */
  readonly project?: Project;
  /** Grows whenever the agent writes to the sandbox. */
  readonly revision: number;
};

/** The two things the panel can show. */
type FilesTab = 'files' | 'changes';

/**
 * The Project's sandbox, as a right-hand panel beside the conversation. It is
 * scoped to the Project, not to the selected Thread, reads nothing it does not
 * show, and never writes: the tree opens directories on demand, a file opens in
 * place of the tree, and the changes view lists the workspace diff.
 *
 * The tabs sit in the header in place of a title, because they name what the
 * panel is showing; the footer carries the path and byte size of the open file
 * and the one action the surface has. Collapsed, the panel keeps a narrow rail
 * whose only content is its toggle, so the control that opens it always sits at
 * the window's right corner and never duplicates the sidebar's own toggle.
 */
export function ProjectFilesSidebar({
  onToggle,
  open,
  project,
  revision,
}: ProjectFilesSidebarProps) {
  // A collapsed panel reads nothing: with no Project the hook stays idle.
  const files = useProjectFiles({
    projectId: open ? project?.id : undefined,
    revision,
  });
  const [tab, setTab] = useState<FilesTab>('files');
  const toggle = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={open ? 'Hide files' : 'Show files'}
      className="mr-2 ml-auto shrink-0 [app-region:no-drag]"
      onClick={onToggle}
    >
      {open ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
    </Button>
  );

  if (!open) {
    return (
      <Sidebar collapsible="none" className="overflow-hidden">
        <PanelHeader separator={false}>{toggle}</PanelHeader>
      </Sidebar>
    );
  }

  return (
    <Sidebar collapsible="none" className="overflow-hidden">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as FilesTab)}
        className="min-h-0 flex-1 gap-0"
      >
        <PanelHeader>
          <TabsList className="h-7! min-w-0 [app-region:no-drag]">
            <TabsTrigger value="files">
              <FilesIcon />
              Files
            </TabsTrigger>
            <TabsTrigger value="changes">
              <FileDiffIcon />
              Changes
            </TabsTrigger>
          </TabsList>
          {toggle}
        </PanelHeader>
        <SidebarContent className="overflow-hidden p-0">
          <SidebarGroup className="h-full min-h-0 p-0">
            <SidebarGroupContent className="flex min-h-0 w-full flex-1 flex-col">
              <TabsContent
                value="files"
                className="flex min-h-0 flex-1 flex-col"
              >
                <SandboxGate files={files} project={project}>
                  <FilesView files={files} />
                </SandboxGate>
              </TabsContent>
              <TabsContent
                value="changes"
                className="flex min-h-0 flex-1 flex-col"
              >
                <SandboxGate files={files} project={project}>
                  <ChangesView files={files} />
                </SandboxGate>
              </TabsContent>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <FilesFooter files={files} />
      </Tabs>
    </Sidebar>
  );
}

/**
 * The panel's header strip: the drag region, its boundary, and whatever the
 * current state puts in it — the tabs and the toggle when expanded, only the
 * toggle when collapsed.
 *
 * The rule under it marks where content begins, so a header with nothing below
 * it draws none: the collapsed rail is a bare toggle in an h-8 strip, and a
 * boundary over empty space reads as a stray line.
 */
function PanelHeader({
  children,
  separator = true,
}: {
  readonly children?: ReactNode;
  readonly separator?: boolean;
}) {
  return (
    <div
      data-slot="project-files-header"
      className="relative flex h-8 shrink-0 items-center bg-sidebar pl-2 [app-region:drag]"
    >
      {separator && (
        <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
      )}
      {children}
    </div>
  );
}

/**
 * What the panel shows when the sandbox itself cannot be read. Both tabs share
 * one answer, because a queued, failed or terminated Project has no files and no
 * changes: the surface explains the Project instead of failing a tab at a time.
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
 * The panel's footer: the path the open file sits at and how many bytes it has,
 * and the one action the surface has, since a read-only view has nothing to
 * submit. Every crumb above the file returns to the tree, where the directory it
 * selects is already open, because the file was reached through it.
 */
function FilesFooter({ files }: { readonly files: ProjectFiles }) {
  const { actions, selectedSize, selectedPath } = files;

  return (
    <footer
      data-slot="project-files-footer"
      className="flex h-8 shrink-0 items-center gap-2 border-t px-3"
    >
      <FileBreadcrumb
        onBack={actions.closeFile}
        path={selectedPath ?? ROOT_PATH}
      />
      {selectedPath !== undefined && selectedSize !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {selectedSize} bytes
        </span>
      )}
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
