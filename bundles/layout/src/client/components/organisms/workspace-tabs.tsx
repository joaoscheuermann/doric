import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsContent } from 'desktop-ui/tabs';
import { FileDiffIcon, FileIcon, TerminalIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { messageFrom } from '../../domain/errors.js';
import type { WorkspaceTabs as TabsState } from '../../domain/workspace-tabs.js';
import { api } from '../../provisional/api/provisional-api.js';
import { FileDiffViewer } from '../../provisional/files/components/file-diff-viewer.js';
import { FileBody } from '../../provisional/files/components/file-viewer.js';
import { ReadFeedback } from '../../provisional/files/components/read-feedback.js';
import {
  baseName,
  fileReadState,
} from '../../provisional/files/domain/files.js';
import {
  pendingReadInterval,
  sandboxReadRetry,
} from '../../provisional/files/domain/sandbox-reads.js';
import { TerminalView } from '../../provisional/terminals/components/terminal-view.js';
import type { Terminal } from '../../provisional/terminals/domain/terminals.js';
import { queryKeys } from '../../queries/keys.js';
import { workspaceTabsStore } from '../../stores/workspace-tabs.js';
import { TabStrip } from '../molecules/tab-strip.js';

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
              if (tab.kind === 'element') {
                // Another bundle's tab (layout.tabs/v1): its title, no icon.
                return {
                  id: tab.id,
                  label: tab.title,
                  ariaLabel: tab.title,
                  title: tab.title,
                  icon: null,
                };
              }
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
                ) : tab.kind === 'element' ? (
                  <ElementTab element={tab.element} />
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

/** Keeps another bundle's tab element mounted in a host of this panel. */
function ElementTab({ element }: { readonly element: object }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = element as Node;
    host.current?.append(node);
    return () => {
      node.parentNode?.removeChild(node);
    };
  }, [element]);
  return <div ref={host} className="min-h-0 flex-1" />;
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
    queryFn: () => api.projects.file(projectId, path),
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
