import { ReadFeedback } from '@/components/molecules/read-feedback';
import { FileBody } from '@/components/organisms/file-viewer';
import { TerminalView } from '@/components/organisms/terminal-view';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { baseName, fileReadState } from '@/domain/files';
import { pendingReadInterval, sandboxReadRetry } from '@/domain/sandbox-reads';
import type { Terminal } from '@/domain/terminals';
import { messageFrom } from '@/domain/workspace';
import type { WorkspaceTabs as TabsState } from '@/domain/workspace-tabs';
import { queryKeys } from '@/queries/keys';
import { workspaceTabsStore } from '@/stores/workspace-tabs';
import { useQuery } from '@tanstack/react-query';
import { FileIcon, TerminalIcon, XIcon } from 'lucide-react';

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
      aria-label="Files and terminals"
      className="flex h-full min-h-0 flex-col bg-sidebar"
    >
      <Tabs
        value={state.selected}
        onValueChange={(id) => actions.select(threadId, id)}
        className="min-h-0 min-w-0 flex-1 gap-0"
      >
        <header className="flex chrome-bar shrink-0 items-center gap-1 border-b px-2">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <TabsList className="w-max justify-start bg-transparent">
              {state.items.map((tab) => {
                const label =
                  tab.kind === 'file'
                    ? baseName(tab.path)
                    : (terminals.find(
                        (terminal) => terminal.id === tab.terminalId,
                      )?.command ?? 'Terminal');
                return (
                  <div
                    key={tab.id}
                    className="group/tab relative flex h-full shrink-0"
                  >
                    <TabsTrigger
                      value={tab.id}
                      data-active={state.selected === tab.id ? '' : undefined}
                      className="max-w-52 rounded-xl pl-2 pr-8 data-[state=active]:border-transparent data-[state=active]:bg-muted data-[state=active]:shadow-none"
                      title={
                        tab.kind === 'file'
                          ? tab.path
                          : terminals.find(
                              (terminal) => terminal.id === tab.terminalId,
                            )?.command
                      }
                    >
                      {tab.kind === 'file' ? <FileIcon /> : <TerminalIcon />}
                      <span className="truncate">{label}</span>
                    </TabsTrigger>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Close ${label}`}
                      className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100"
                      onClick={() => actions.close(threadId, tab.id)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                );
              })}
            </TabsList>
          </div>
        </header>
        {state.items.map((tab) => {
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
