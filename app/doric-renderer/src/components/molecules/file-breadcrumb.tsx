import { Fragment } from 'react';

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { collapsedPath } from '@/domain/files';

type FileBreadcrumbProps = {
  /** Returns to the tree the file was opened from. */
  readonly onBack: () => void;
  /** The path of the open file, from the workspace root down. */
  readonly path: string;
};

/**
 * The chain from the workspace root to the open file. It lives in the file
 * viewer's footer so the reading column keeps its full height, and a chain too
 * deep for that row puts its middle behind one trigger instead of clipping it:
 * the rule that decides what collapses is `domain/files.ts`'s `collapsedPath`.
 * Every crumb above the file returns to the tree, where the directory it selects
 * is already open, because the file was reached through it; the last crumb is
 * the file itself, and it truncates when it alone is wider than the row.
 */
export function FileBreadcrumb({ onBack, path }: FileBreadcrumbProps) {
  const { hidden, leading, trailing } = collapsedPath(path);
  const crumbs = [leading, ...trailing];

  return (
    <Breadcrumb className="min-w-0 overflow-hidden">
      <BreadcrumbList className="flex-nowrap gap-1 text-xs">
        <BreadcrumbItem className="shrink-0">
          <BreadcrumbLink asChild>
            <button type="button" className="font-mono" onClick={onBack}>
              {leading.name}
            </button>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {hidden.length > 0 && (
          <>
            <BreadcrumbSeparator className="shrink-0" />
            <BreadcrumbItem className="shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Show the hidden path"
                  className="flex items-center gap-1"
                >
                  <BreadcrumbEllipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {hidden.map((segment) => (
                    <DropdownMenuItem
                      key={segment.path}
                      className="font-mono"
                      onSelect={onBack}
                    >
                      {segment.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
          </>
        )}
        {crumbs.slice(1).map((segment, index, shown) => {
          const last = index === shown.length - 1;
          return (
            <Fragment key={segment.path}>
              <BreadcrumbSeparator className="shrink-0" />
              <BreadcrumbItem className={last ? 'min-w-0' : 'shrink-0'}>
                {last ? (
                  <BreadcrumbPage className="min-w-0 truncate font-mono">
                    {segment.name}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      className="font-mono"
                      onClick={onBack}
                    >
                      {segment.name}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
