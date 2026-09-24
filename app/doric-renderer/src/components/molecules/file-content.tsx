import { ScrollArea } from '@/components/ui/scroll-area';
import { truncationNotice } from '@/domain/files';
import type { ProjectFileContent } from '@/domain/workspace';

type FileContentProps = {
  readonly file: ProjectFileContent;
};

/**
 * One file's text, readable and selectable: monospace in a scroll area, honest
 * about a payload the host cut short, and a sentence rather than mangled text
 * for a file that is not text at all. The file's path and size are the footer's
 * business.
 */
export function FileContent({ file }: FileContentProps) {
  const notice = truncationNotice(file.truncated);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {file.binary ? (
          <p className="p-3 text-xs text-muted-foreground">
            This is a binary file, so its contents are not shown.
          </p>
        ) : (
          <pre className="p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap select-text">
            {file.content}
          </pre>
        )}
      </ScrollArea>
      {notice !== undefined && (
        <p className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
