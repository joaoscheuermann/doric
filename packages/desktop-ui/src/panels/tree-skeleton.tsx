import { Skeleton } from '../components/skeleton.js';
import { indentation, TreeGuides } from './tree-guides.js';

const rows = [
  { id: 'root', depth: 0, folder: true, width: 'w-24' },
  { id: 'folder-a', depth: 1, folder: true, width: 'w-28' },
  { id: 'file-a1', depth: 2, folder: false, width: 'w-24' },
  { id: 'file-a2', depth: 2, folder: false, width: 'w-32' },
  { id: 'file-a3', depth: 1, folder: false, width: 'w-20' },
  { id: 'folder-b', depth: 0, folder: true, width: 'w-20' },
  { id: 'file-b1', depth: 1, folder: false, width: 'w-28' },
];

/**
 * Mirrors tree row heights, nesting, icons and name columns during the first
 * read. `root` adds a row above the tree for the node the tree hangs from (a
 * repository, in the Changes view), so every row sits one level deeper.
 */
export function TreeSkeleton({
  root = false,
  label,
}: {
  readonly root?: boolean;
  /** The status the skeleton announces; the bundle that shows the tree names it. */
  readonly label: string;
}) {
  const levels = root
    ? rows.map((row) => ({ ...row, depth: row.depth + 1 }))
    : rows;
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className="min-w-0 overflow-hidden"
    >
      <div aria-hidden className="py-1">
        {root && (
          <div
            className="relative flex h-7 items-center gap-2 pr-8"
            style={{ paddingLeft: indentation(0) }}
          >
            <Skeleton className="size-3 shrink-0" />
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="absolute right-1 h-3 w-12" />
          </div>
        )}
        {levels.map((row) => (
          <div
            key={row.id}
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
