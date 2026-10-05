import { TabStrip } from '@/components/molecules/tab-strip';
import { TerminalView } from '@/components/organisms/terminal-view';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent } from '@/components/ui/tabs';
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
        <TabStrip
          label="Manual terminals"
          selected={state.manualId}
          onMove={(from, to) => actions.moveManual(threadId, from, to)}
          onClose={(id) => actions.closeManual(threadId, id)}
          items={(state.manualIds ?? []).flatMap((id) => {
            const session = terminals.find((terminal) => terminal.id === id);
            return session
              ? [
                  {
                    id,
                    label: `${session.command}${session.state === 'exited' ? ' · exited' : ''}`,
                    icon: <TerminalIcon />,
                  },
                ]
              : [];
          })}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide terminals"
          onClick={() => actions.manual(threadId)}
        >
          <XIcon />
        </Button>
      </header>
      {state.manualIds
        ?.slice()
        .sort()
        .map((id) => {
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
