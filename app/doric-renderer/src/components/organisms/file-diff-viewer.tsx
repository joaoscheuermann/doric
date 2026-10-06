import { useRef } from 'react';

import {
  type DiffControls,
  DiffEditor,
} from '@/components/molecules/diff-editor';
import { DiffFooter } from '@/components/molecules/diff-footer';
import { DiffToolbar } from '@/components/molecules/diff-toolbar';
import { ReadFeedback } from '@/components/molecules/read-feedback';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { fileLanguage, joinPath, sandboxNotice } from '@/domain/files';
import { messageFrom } from '@/domain/workspace';
import type { WorkspaceTab } from '@/domain/workspace-tabs';
import { useFileDiff } from '@/hooks/use-file-diff';
import { workspaceTabsStore } from '@/stores/workspace-tabs';

/** One comparison on demand; background refresh leaves its editor mounted. */
export function FileDiffViewer({
  tab,
  threadId,
}: {
  readonly tab: Extract<WorkspaceTab, { kind: 'diff' }>;
  readonly threadId: string;
}) {
  const query = useFileDiff(tab.projectId, tab.repository, tab.path);
  const result = query.data;
  const diff = result?.status === 'ready' ? result.diff : undefined;
  const deleted = useRef(false);
  if (diff) deleted.current = diff.status === 'deleted';
  const path = joinPath(tab.repository, tab.path);
  const toolbar = (controls?: DiffControls) => (
    <DiffToolbar
      path={path}
      change={diff}
      truncated={diff?.truncated}
      controls={controls}
      canOpen={!deleted.current && (!!diff || result?.status === 'not_found')}
      onOpen={() =>
        workspaceTabsStore.getState().open(threadId, {
          kind: 'file',
          id: `file:${path}`,
          projectId: tab.projectId,
          path,
        })
      }
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
          <>
            {diff.binary ? (
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
                toolbar={toolbar}
                footer={(controls) => (
                  <DiffFooter path={path} controls={controls} />
                )}
              />
            )}
          </>
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
            {Array.from({ length: 12 }, (_, index) => (
              <Skeleton key={index} className="h-3 w-full" />
            ))}
          </div>
        )}
      </div>
      {(!diff || diff.binary) && <DiffFooter path={path} />}
    </>
  );
}
