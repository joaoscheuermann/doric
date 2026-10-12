// <files-file-view projectId path> (stage 10, §3.6): one file tab, moved
// from the workspace tabs' `TabFile` (`workspace-tabs.tsx`), `FileBody`
// (`file-viewer.tsx`) and `FileContent` (`file-content.tsx`): the file read
// with its toast, the file's text or why it is not shown, and the footer with
// the path and the `Updating…` status.

import { useQuery } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { messageFrom, pendingReadInterval, readRetry } from 'desktop/reads';
import { CodeView, fileLanguage } from 'desktop/ui/code';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from 'desktop/ui/empty';
import { ReadFeedback } from 'desktop/ui/panels';
import { ScrollArea } from 'desktop/ui/scroll-area';
import { Skeleton } from 'desktop/ui/skeleton';
import { AlertCircleIcon, FileIcon } from 'lucide-react';

import type { ReadState } from '../../contracts/index.js';
import { sandboxNotice } from '../../contracts/index.js';
import { filesReadsOf } from '../api/reads.js';
import { useProjectReads } from '../hooks/use-project-reads.js';
import type { ProjectFileContent } from '../reads/project-files.js';
import { fileReadState, truncationNotice } from '../reads/state.js';
import { filesKeys } from '../sandbox-store.js';

export function FileView({
  services,
  projectId,
  path,
}: {
  readonly services: Services;
  readonly projectId?: string;
  readonly path?: string;
}) {
  if (projectId === undefined || path === undefined) return null;
  return <TabFile services={services} projectId={projectId} path={path} />;
}

function TabFile({
  services,
  projectId,
  path,
}: {
  readonly services: Services;
  readonly projectId: string;
  readonly path: string;
}) {
  const query = useQuery({
    ...readRetry,
    queryKey: filesKeys.file(projectId, path),
    queryFn: () => filesReadsOf(services).file(projectId, path),
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : pendingReadInterval(query.state.data),
  });
  useProjectReads(projectId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ReadFeedback
        error={query.isError ? messageFrom(query.error) : undefined}
        refreshing={query.isFetching}
        onRetry={() => void query.refetch()}
      />
      <FileBody
        file={fileReadState(query.data, query.isPending, query.isError)}
        failed={query.isError}
      />
      <footer className="flex chrome-bar shrink-0 items-center border-t px-3">
        <span className="truncate font-mono text-xs" title={path}>
          {path}
        </span>
        <span
          role="status"
          className="ml-auto shrink-0 text-xs text-muted-foreground"
        >
          {query.isFetching ? 'Updating…' : ''}
        </span>
      </footer>
    </div>
  );
}

/** The placeholder rows a read draws until its text arrives. */
const FILE_SKELETON_ROWS = Array.from(
  { length: 12 },
  (_, row) => `file-skeleton-${row}`,
);

/**
 * The file's text, or what the viewer shows while it waits for it: only the
 * text of the file or the sentence that says why it is not here.
 */
export function FileBody({
  file,
  failed = false,
}: {
  readonly file: ReadState<ProjectFileContent>;
  readonly failed?: boolean;
}) {
  if (file.status === 'ready') return <FileContent file={file.value} />;
  if (failed) return null;
  if (file.status === 'idle' || file.status === 'loading') {
    return (
      <div className="flex flex-col gap-2 p-3">
        {FILE_SKELETON_ROWS.map((row) => (
          <Skeleton key={row} className="h-3 w-full" />
        ))}
      </div>
    );
  }
  return (
    <Empty className="p-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {file.status === 'invalid_path' || file.status === 'not_found' ? (
            <AlertCircleIcon />
          ) : (
            <FileIcon />
          )}
        </EmptyMedia>
        <EmptyTitle>This file cannot be shown</EmptyTitle>
        <EmptyDescription>
          {sandboxNotice(file.status, file.retryAfterSeconds)}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * One file's text, readable and selectable: the editor the language of the
 * file's path calls for, honest about a payload the host cut short, and a
 * sentence rather than mangled text for a file that is not text at all.
 */
export function FileContent({ file }: { readonly file: ProjectFileContent }) {
  const notice = truncationNotice(file.truncated);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {file.binary ? (
        <ScrollArea className="min-h-0 flex-1">
          <p className="p-3 text-xs text-muted-foreground">
            This is a binary file, so its contents are not shown.
          </p>
        </ScrollArea>
      ) : (
        <CodeView language={fileLanguage(file.path)} value={file.content} />
      )}
      {notice !== undefined && (
        <p className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
