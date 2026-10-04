import { TerminalView } from '@/components/organisms/terminal-view';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Terminal } from '@/domain/terminals';
import type { WorkspaceTabs } from '@/domain/workspace-tabs';
import { workspaceTabsStore } from '@/stores/workspace-tabs';
import { TerminalIcon, XIcon } from 'lucide-react';

/** The manual shells opened in one Thread, each retaining its own emulator. */
export function ManualTerminalTabs({
  state,
  threadId,
  terminals,
}: {
  readonly state: WorkspaceTabs;
  readonly threadId: string;
  readonly terminals: readonly Terminal[];
}) {
  const actions = workspaceTabsStore.getState();
  return (
    <Tabs
      value={state.manualId}
      onValueChange={(id) => actions.manual(threadId, id)}
      className="h-full min-h-0 gap-0"
    >
      <header className="flex chrome-bar shrink-0 items-center gap-1 border-b bg-sidebar px-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <TabsList
            aria-label="Manual terminals"
            className="w-max justify-start bg-transparent"
          >
            {state.manualIds?.map((id) => {
              const session = terminals.find((terminal) => terminal.id === id);
              if (!session) return null;
              return (
                <div
                  key={id}
                  className="group/tab relative flex h-full shrink-0"
                >
                  <TabsTrigger
                    value={id}
                    data-active={state.manualId === id ? '' : undefined}
                    title={session.command}
                    className="max-w-52 rounded-xl pl-2 pr-8 data-[state=active]:border-transparent data-[state=active]:bg-muted data-[state=active]:shadow-none"
                  >
                    <TerminalIcon />
                    <span className="truncate">
                      {session.command}
                      {session.state === 'exited' ? ' · exited' : ''}
                    </span>
                  </TabsTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Close ${session.command}`}
                    className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100"
                    onClick={() => actions.closeManual(threadId, id)}
                  >
                    <XIcon />
                  </Button>
                </div>
              );
            })}
          </TabsList>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide terminals"
          onClick={() => actions.manual(threadId)}
        >
          <XIcon />
        </Button>
      </header>
      {state.manualIds?.map((id) => {
        const session = terminals.find((terminal) => terminal.id === id);
        return (
          session && (
            <TabsContent
              key={id}
              value={id}
              forceMount
              hidden={state.manualId !== id}
              data-active={state.manualId === id}
              className="min-h-0 flex-1 data-[active=true]:flex data-[active=true]:flex-col"
            >
              <TerminalView session={session} showHeader={false} />
            </TabsContent>
          )
        );
      })}
    </Tabs>
  );
}
