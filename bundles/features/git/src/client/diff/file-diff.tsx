// <git-file-diff projectId repository path> (stage 10, §3.8): one comparison
// tab, moved from the provisional `FileDiffViewer` (`file-diff-viewer.tsx`):
// the comparison read with its toast, the diff editor or why there is none,
// and the toolbar and footer. "Open file" runs `files.open-file/v1` with the
// workspace path the comparison names.

import { CommandsV1, type Services } from 'bundle/contracts';
import { joinPath, messageFrom } from 'desktop/reads';
import { type DiffControls, DiffEditor, fileLanguage } from 'desktop/ui/code';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from 'desktop/ui/empty';
import { ReadFeedback } from 'desktop/ui/panels';
import { Skeleton } from 'desktop/ui/skeleton';
import { sandboxNotice } from 'files/contracts';
import { useRef } from 'react';

import { OPEN_FILE_COMMAND } from '../api/peers.js';
import { useFileDiff } from '../hooks/use-file-diff.js';
import { useProjectReads } from '../hooks/use-project-reads.js';
import { useService } from '../hooks/use-service.js';
import { DiffFooter } from './diff-footer.js';
import { DiffToolbar } from './diff-toolbar.js';

/** The placeholder rows a read draws until its comparison arrives. */
const DIFF_SKELETON_ROWS = Array.from(
  { length: 12 },
  (_, row) => `diff-skeleton-${row}`,
);

export function FileDiffView({
  services,
  projectId,
  repository,
  path,
}: {
  readonly services: Services;
  readonly projectId?: string;
  readonly repository?: string;
  readonly path?: string;
}) {
  if (projectId === undefined || repository === undefined || path === undefined)
    return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileDiffViewer
        services={services}
        projectId={projectId}
        repository={repository}
        path={path}
      />
    </div>
  );
}

/** One comparison on demand; background refresh leaves its editor mounted. */
function FileDiffViewer({
  services,
  projectId,
  repository,
  path: changedPath,
}: {
  readonly services: Services;
  readonly projectId: string;
  readonly repository: string;
  readonly path: string;
}) {
  const commands = useService(services, CommandsV1);
  const query = useFileDiff(projectId, repository, changedPath);
  useProjectReads(projectId);
  const result = query.data;
  const diff = result?.status === 'ready' ? result.diff : undefined;
  const deleted = useRef(false);
  if (diff) deleted.current = diff.status === 'deleted';
  const path = joinPath(repository, changedPath);
  const toolbar = (controls?: DiffControls) => (
    <DiffToolbar
      path={path}
      change={diff}
      truncated={diff?.truncated}
      controls={controls}
      canOpen={!deleted.current && (!!diff || result?.status === 'not_found')}
      onOpen={() => {
        void commands
          ?.execute(OPEN_FILE_COMMAND, { projectId, path })
          .catch(() => undefined);
      }}
    />
  );
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {(!diff || diff.binary) && toolbar()}
        <ReadFeedback
          error={query.isError ? messageFrom(query.error) : undefined}
          refreshing={query.isFetching}
          onRetry={() => void query.refetch()}
        />
        {diff ? (
          diff.binary ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Binary file changed</EmptyTitle>
                <EmptyDescription>
                  A text comparison is not available for this file.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <DiffEditor
              original={diff.original}
              modified={diff.modified}
              language={fileLanguage(diff.path)}
              diffTokens={{ added: '--git-added', removed: '--git-deleted' }}
              toolbar={toolbar}
              footer={(controls) => (
                <DiffFooter path={path} controls={controls} />
              )}
            />
          )
        ) : query.isError ? null : result ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>This comparison is unavailable</EmptyTitle>
              <EmptyDescription>
                {result.status === 'ready'
                  ? ''
                  : result.status === 'not_found'
                    ? 'This file no longer has a comparison to show. It may have been committed, reverted or removed.'
                    : sandboxNotice(
                        result.status,
                        'retryAfterSeconds' in result
                          ? result.retryAfterSeconds
                          : undefined,
                      )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {DIFF_SKELETON_ROWS.map((row) => (
              <Skeleton key={row} className="h-3 w-full" />
            ))}
          </div>
        )}
      </div>
      {(!diff || diff.binary) && <DiffFooter path={path} />}
    </>
  );
}
