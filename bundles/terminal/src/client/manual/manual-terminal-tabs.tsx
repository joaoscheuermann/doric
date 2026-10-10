import { Button } from 'desktop-ui/button';
import { Tabs, TabsContent } from 'desktop-ui/tabs';
import { TabStrip } from 'desktop-ui/workspace';
import { TerminalIcon, XIcon } from 'lucide-react';

import type { TerminalApi } from '../api.js';
import type { ManualTerminals } from '../domain/manual.js';
import type { Terminal } from '../domain/terminals.js';
import type { TerminalWatchApi } from '../output-watch.js';
import type { TerminalStore } from '../store.js';
import { TerminalView } from '../view/terminal-view.js';

/**
 * The manual shells opened in one Thread, each retaining its own emulator
 * (moved from the layout's provisional `manual-terminal-tabs.tsx`).
 */
export function ManualTerminalTabs({
  api,
  watches,
  store,
  state,
  threadId,
  terminals,
}: {
  readonly api: TerminalApi;
  readonly watches: TerminalWatchApi;
  readonly store: TerminalStore;
  readonly state: ManualTerminals;
  readonly threadId: string;
  readonly terminals: readonly Terminal[];
}) {
  const actions = {
    manual: (thread: string, id?: string) => store.showManual(thread, id),
    moveManual: (thread: string, from: string, to: string) =>
      store.moveManual(thread, from, to),
    closeManual: (thread: string, id: string) => store.closeManual(thread, id),
  };
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
                <TerminalView
                  api={api}
                  watches={watches}
                  session={session}
                  showHeader={false}
                />
              </TabsContent>
            )
          );
        })}
    </Tabs>
  );
}
