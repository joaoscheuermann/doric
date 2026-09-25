import { CodeView } from '@/components/molecules/code-view';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fileLanguage, truncationNotice } from '@/domain/files';
import type { ProjectFileContent } from '@/domain/workspace';

type FileContentProps = {
  readonly file: ProjectFileContent;
};

/**
 * One file's text, readable and selectable: the editor the language of the
 * file's path calls for, honest about a payload the host cut short, and a
 * sentence rather than mangled text for a file that is not text at all.
 */
export function FileContent({ file }: FileContentProps) {
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
