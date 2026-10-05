import { indentation, TreeGuides } from '@/components/molecules/tree-guides';
import { Skeleton } from '@/components/ui/skeleton';

const rows = [
  { depth: 0, folder: true, width: 'w-24' },
  { depth: 1, folder: true, width: 'w-28' },
  { depth: 2, folder: false, width: 'w-24' },
  { depth: 2, folder: false, width: 'w-32' },
  { depth: 1, folder: false, width: 'w-20' },
  { depth: 0, folder: true, width: 'w-20' },
  { depth: 1, folder: false, width: 'w-28' },
];

/** Mirrors tree row heights, nesting, icons and name columns during the first read. */
export function TreeSkeleton({
  changes = false,
}: {
  readonly changes?: boolean;
}) {
  return (
    <div
      role="status"
      aria-label={changes ? 'Loading changes' : 'Loading files'}
      aria-busy="true"
      className="min-w-0 overflow-hidden"
    >
      <div aria-hidden className="py-1">
        {changes && (
          <div className="flex h-8 items-center gap-2 px-2">
            <Skeleton className="size-3" />
            <Skeleton className="size-4" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="ml-auto h-3 w-8" />
            <Skeleton className="h-3 w-8" />
          </div>
        )}
        {rows.map((row, index) => (
          <div
            key={index}
            className="relative flex h-7 items-center gap-2 pr-8"
            style={{ paddingLeft: indentation(row.depth) }}
          >
            <TreeGuides depth={row.depth} />
            {row.folder && <Skeleton className="size-3 shrink-0" />}
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className={`h-3 ${row.width}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
