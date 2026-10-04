import { FileBreadcrumb } from '@/components/molecules/file-breadcrumb';
import { FileContent } from '@/components/molecules/file-content';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { baseName, sandboxNotice } from '@/domain/files';
import type { ProjectFileContent } from '@/domain/workspace';
import type { ReadState } from '@/hooks/use-project-files';
import { AlertCircleIcon, FileIcon, XIcon } from 'lucide-react';

type FileViewerProps = {
  /** The content of the selected file, or why there is none. */
  readonly file: ReadState<ProjectFileContent>;
  /**
   * Closes the viewer. The selection it shows belongs to the sandbox surface,
   * so the control reports the intent and that surface drops the file.
   */
  readonly onClose: () => void;
  /** The path of the selected file, which the header and footer name. */
  readonly path: string;
};

/**
 * The selected file, as a division of its own beside the sandbox panel. It is
 * opened by a file row in that panel, so the tree it was opened from stays where
 * it was and the reading column gets the rest of the width; the split between
 * the two is resizable, and this surface only ever reads.
 *
 * The header names the file, because a header is what says which file this is,
 * and carries the one control it has — closing it — at the right corner. The
 * footer states the chain the file was reached through; every crumb above the
 * file returns to the tree, where the directory it selects is already open. The
 * text itself is the Monaco editor, in read-only mode (see `FileContent`).
 */
export function FileViewer({ file, onClose, path }: FileViewerProps) {
  return (
    <section
      aria-label="File viewer"
      data-slot="file-viewer"
      className="flex h-full min-h-0 flex-col bg-sidebar"
    >
      <header
        data-slot="file-viewer-header"
        className="relative flex chrome-bar shrink-0 items-center gap-2 bg-sidebar pl-3 [app-region:drag]"
      >
        <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
        <span className="min-w-0 truncate font-mono text-xs">
          {baseName(path)}
        </span>
        <div className="ml-auto flex shrink-0 items-center pr-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close file"
            className="shrink-0 [app-region:no-drag]"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <FileBody file={file} />
      </div>
      <footer
        data-slot="file-viewer-footer"
        className="flex chrome-bar shrink-0 items-center gap-2 border-t px-3"
      >
        <FileBreadcrumb onBack={onClose} path={path} />
      </footer>
    </section>
  );
}

/**
 * The file's text, or what the viewer shows while it waits for it. The path and
 * byte size belong to the header and footer around this, so this is only the
 * text of the file or the sentence that says why it is not here.
 */
export function FileBody({
  file,
}: {
  readonly file: ReadState<ProjectFileContent>;
}) {
  if (file.status === 'ready') return <FileContent file={file.value} />;
  if (file.status === 'idle' || file.status === 'loading') {
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton key={index} className="h-3 w-full" />
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
