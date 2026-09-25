import { type DiffFile, type DiffLineKind, diffStat } from '@/domain/files';
import { cn } from '@/utility/utils';

/**
 * The one-character column every line keeps, so a hunk header and the lines
 * under it share an edge. A piece of metadata has no marker of its own, so its
 * column is blank.
 */
const marker = (kind: DiffLineKind): string => {
  if (kind === 'add') return '+';
  if (kind === 'remove') return '-';
  return ' ';
};

/** Context stays plain, an addition and a removal are tinted, metadata recedes. */
const tone = (kind: DiffLineKind): string => {
  if (kind === 'add') return 'bg-primary/10';
  if (kind === 'remove') return 'bg-destructive/10';
  if (kind === 'meta') return 'text-muted-foreground';
  return '';
};

/**
 * A diff as one section per changed file, its path and line counts as the
 * heading and every line in a full-width row, so a long line scrolls sideways
 * instead of wrapping into a shape the diff does not have.
 */
export function DiffView({ files }: { readonly files: readonly DiffFile[] }) {
  return (
    <div className="flex min-w-0 flex-col">
      {files.map((file) => {
        const stat = diffStat([file]);
        return (
          <section key={file.path} className="border-b last:border-b-0">
            <h3 className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="truncate font-mono">{file.path}</span>
              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                +{stat.added} -{stat.removed}
              </span>
            </h3>
            <div className="overflow-x-auto">
              <div className="min-w-max font-mono text-xs leading-relaxed select-text">
                {file.lines.map((line, index) => (
                  <div
                    key={index}
                    className={cn('px-3 whitespace-pre', tone(line.kind))}
                  >
                    {marker(line.kind)}
                    {line.text}
                  </div>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
