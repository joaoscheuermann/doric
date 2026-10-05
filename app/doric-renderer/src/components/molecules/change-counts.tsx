/** Shared totals for a repository and the Changes tab. */
export function ChangeCounts({
  added,
  removed,
}: {
  readonly added: number;
  readonly removed: number;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums"
      aria-label={`${added} lines added, ${removed} lines removed`}
    >
      <span className="text-git-added">+{added}</span>
      <span className="text-git-deleted">−{removed}</span>
    </span>
  );
}
