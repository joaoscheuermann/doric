import { ReadFeedback } from '@/components/molecules/read-feedback';
import { TabStrip } from '@/components/molecules/tab-strip';
import { FileDiffViewer } from '@/components/organisms/file-diff-viewer';
import { FileBody } from '@/components/organisms/file-viewer';
import { TerminalView } from '@/components/organisms/terminal-view';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { baseName, fileReadState } from '@/domain/files';
import { pendingReadInterval, sandboxReadRetry } from '@/domain/sandbox-reads';
import type { Terminal } from '@/domain/terminals';
import { messageFrom } from '@/domain/workspace';
import type { WorkspaceTabs as TabsState } from '@/domain/workspace-tabs';
import { queryKeys } from '@/queries/keys';
import { workspaceTabsStore } from '@/stores/workspace-tabs';
import { useQuery } from '@tanstack/react-query';
import { FileDiffIcon, FileIcon, TerminalIcon } from 'lucide-react';

export function WorkspaceTabs({
  state,
  threadId,
  terminals,
}: {
  readonly state: TabsState;
  readonly threadId: string;
  readonly terminals: readonly Terminal[];
}) {
  const actions = workspaceTabsStore.getState();
  return (
    <section
      aria-label="Files, changes and terminals"
      className="flex h-full min-h-0 flex-col bg-sidebar"
    >
      <Tabs
        value={state.selected}
        onValueChange={(id) => actions.select(threadId, id)}
        className="min-h-0 min-w-0 flex-1 gap-0"
      >
        <header className="flex chrome-bar shrink-0 items-center gap-1 border-b px-2">
          <TabStrip
            label="Files, changes and terminals"
            selected={state.selected}
            onMove={(from, to) => actions.move(threadId, from, to)}
            onClose={(id) => actions.close(threadId, id)}
            items={state.items.map((tab) => {
              const label =
                tab.kind !== 'terminal'
                  ? baseName(tab.path)
                  : (terminals.find(
                      (terminal) => terminal.id === tab.terminalId,
                    )?.command ?? 'Terminal');
              return {
                id: tab.id,
                label,
                ariaLabel: tab.kind === 'diff' ? `${label} changes` : label,
                title: tab.kind !== 'terminal' ? tab.path : label,
                icon:
                  tab.kind === 'diff' ? (
                    <FileDiffIcon />
                  ) : tab.kind === 'file' ? (
                    <FileIcon />
                  ) : (
                    <TerminalIcon />
                  ),
              };
            })}
          />
        </header>
        {/* Keep panels in stable DOM order when their triggers are moved. */}
        {state.items
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((tab) => {
            const session =
              tab.kind === 'terminal'
                ? terminals.find((terminal) => terminal.id === tab.terminalId)
                : undefined;
            return (
              <TabsContent
                key={tab.id}
                value={tab.id}
                forceMount
                hidden={state.selected !== tab.id}
                className="min-h-0 flex-1 data-[active=true]:flex data-[active=true]:flex-col"
                data-active={state.selected === tab.id}
              >
                {tab.kind === 'file' ? (
                  <TabFile projectId={tab.projectId} path={tab.path} />
                ) : tab.kind === 'diff' ? (
                  <FileDiffViewer tab={tab} threadId={threadId} />
                ) : (
                  session && <TerminalView session={session} />
                )}
              </TabsContent>
            );
          })}
      </Tabs>
    </section>
  );
}

function TabFile({
  projectId,
  path,
}: {
  readonly projectId: string;
  readonly path: string;
}) {
  const query = useQuery({
    ...sandboxReadRetry,
    queryKey: queryKeys.files.file(projectId, path),
    queryFn: () => window.doric.projects.file(projectId, path),
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : pendingReadInterval(query.state.data),
  });
  return (
    <>
      <ReadFeedback
        error={query.isError ? messageFrom(query.error) : undefined}
        refreshing={query.isFetching}
        onRetry={() => void query.refetch()}
      />
      <FileBody
        file={fileReadState(query.data, query.isPending, query.isError)}
        failed={query.isError}
      />
      <footer className="flex chrome-bar shrink-0 items-center border-t px-3">
        <span className="truncate font-mono text-xs" title={path}>
          {path}
        </span>
        <span
          role="status"
          className="ml-auto shrink-0 text-xs text-muted-foreground"
        >
          {query.isFetching ? 'Updating…' : ''}
        </span>
      </footer>
    </>
  );
}
