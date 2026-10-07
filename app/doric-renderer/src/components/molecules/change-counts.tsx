import { cn } from '@/utility/utils';

/** Shared Git totals; an empty comparison uses the same muted style everywhere. */
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
        className={cn(empty ? 'text-muted-foreground' : 'text-git-added')}
      >
        +{added}
      </span>
      <span
        aria-hidden="true"
        className={cn(empty ? 'text-muted-foreground' : 'text-git-deleted')}
      >
        −{removed}
      </span>
      <span className="sr-only">
        {added} lines added, {removed} lines removed
      </span>
    </span>
  );
}
