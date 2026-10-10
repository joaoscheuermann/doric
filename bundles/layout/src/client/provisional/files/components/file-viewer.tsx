// `FileBody` only: the renderer's `FileViewer` component was never mounted
// (dead code, E.13) and was not moved.
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from 'desktop-ui/empty';
import { Skeleton } from 'desktop-ui/skeleton';
import { AlertCircleIcon, FileIcon } from 'lucide-react';

import { sandboxNotice } from '../domain/files.js';
import type { ProjectFileContent } from '../domain/project-files.js';
import type { ReadState } from '../hooks/use-project-files.js';
import { FileContent } from './file-content.js';

/** The placeholder rows a read draws until its text arrives. */
const FILE_SKELETON_ROWS = Array.from(
  { length: 12 },
  (_, row) => `file-skeleton-${row}`,
);

/**
 * The file's text, or what the viewer shows while it waits for it. The path and
 * byte size belong to the header and footer around this, so this is only the
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
