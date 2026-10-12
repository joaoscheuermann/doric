// The tab panel beside the conversation: every tab is another bundle's
// element (`layout.tabs/v1`) since WP-10N moved the file, diff and terminal
// tabs to the files, git and terminal bundles.

import { TabStrip } from 'desktop-ui/panels';
import { Tabs, TabsContent } from 'desktop-ui/tabs';
import { FileDiffIcon, FileIcon, TerminalIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { WorkspaceTabs as TabsState } from '../../domain/workspace-tabs.js';
import { workspaceTabsStore } from '../../stores/workspace-tabs.js';

export function WorkspaceTabs({
  state,
  threadId,
}: {
  readonly state: TabsState;
  readonly threadId: string;
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
            items={state.items.flatMap((tab) =>
              tab.kind === 'element'
                ? [
                    {
                      // Another bundle's tab (layout.tabs/v1): its title, and
                      // from 1.1.0 the icon, aria label and tooltip it asked for.
                      id: tab.id,
                      label: tab.title,
                      ariaLabel: tab.ariaLabel ?? tab.title,
                      title: tab.tooltip ?? tab.title,
                      icon: tabIcon(tab.icon),
                    },
                  ]
                : [],
            )}
          />
        </header>
        {/* Keep panels in stable DOM order when their triggers are moved. */}
        {state.items
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .flatMap((tab) =>
            tab.kind === 'element'
              ? [
                  <TabsContent
                    key={tab.id}
                    value={tab.id}
                    forceMount
                    hidden={state.selected !== tab.id}
                    className="min-h-0 flex-1 data-[active=true]:flex data-[active=true]:flex-col"
                    data-active={state.selected === tab.id}
                  >
                    <ElementTab element={tab.element} />
                  </TabsContent>,
                ]
              : [],
          )}
      </Tabs>
    </section>
  );
}

/** The trigger icon an element tab asked for (`layout.tabs/v1@1.1.0`). */
function tabIcon(icon: 'file' | 'file-diff' | 'terminal' | undefined) {
  switch (icon) {
    case 'file':
      return <FileIcon />;
    case 'file-diff':
      return <FileDiffIcon />;
    case 'terminal':
      return <TerminalIcon />;
    default:
      return null;
  }
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
