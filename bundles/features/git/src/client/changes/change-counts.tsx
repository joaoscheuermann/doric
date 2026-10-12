import { cn } from 'desktop-ui/utils';

/**
 * Git's line totals. An empty comparison uses the muted style; a change adds in
 * the added colour and removes in the deleted one (the `--git-*` variables this
 * bundle's stylesheet declares).
 */
export function ChangeCounts({
  added,
  removed,
}: {
  readonly added: number;
  readonly removed: number;
}) {
  const empty = added === 0 && removed === 0;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums">
      <span
        aria-hidden="true"
        className={cn(
          empty ? 'text-muted-foreground' : 'text-[var(--git-added)]',
        )}
      >
        +{added}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          empty ? 'text-muted-foreground' : 'text-[var(--git-deleted)]',
        )}
      >
        −{removed}
      </span>
      <span className="sr-only">
        {added} lines added, {removed} lines removed
      </span>
    </span>
  );
}
