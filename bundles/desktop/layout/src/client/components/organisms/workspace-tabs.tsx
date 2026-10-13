// The tab panel beside the conversation: every tab is another bundle's
// element (`layout.tabs/v1`) since WP-10N moved the file, diff and terminal
// tabs to the files, git and terminal bundles.

import { TabStrip } from 'desktop/ui/panels';
import { TabsContent } from 'desktop/ui/tabs';
import {
  FileDiffIcon,
  FileIcon,
  MessageSquareIcon,
  TerminalIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

import { LayoutTabsV1, type TabIcon } from '../../../contracts/index.js';
import type { WorkspaceTabs as TabsState } from '../../domain/workspace-tabs.js';
import { layoutServices } from '../../services/layout-services.js';
import { workspaceStore } from '../../stores/workspace.js';
import { workspaceTabsStore } from '../../stores/workspace-tabs.js';

export function WorkspaceTabBar({
  state,
  threadId,
}: {
  readonly state: TabsState;
  readonly threadId: string;
}) {
  const actions = workspaceTabsStore.getState();
  return (
    <TabStrip
      variant="project"
      label="Files, changes, terminals and threads"
      selected={state.selected}
      onMove={(from, to) => actions.move(threadId, from, to)}
      onClose={(id) => {
        void layoutServices()
          .use(LayoutTabsV1)
          .close({ id, threadId })
          .catch((reason: unknown) => workspaceStore.getState().fail(reason));
      }}
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
  );
}

export function WorkspaceTabs({ state }: { readonly state: TabsState }) {
  return (
    <section
      aria-label="Files, changes, terminals and threads"
      className="flex h-full min-h-0 flex-col bg-sidebar"
    >
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
    </section>
  );
}

/** The trigger icon an element tab asked for (`layout.tabs/v1@1.1.0`). */
function tabIcon(icon: TabIcon | undefined) {
  switch (icon) {
    case 'file':
      return <FileIcon />;
    case 'file-diff':
      return <FileDiffIcon />;
    case 'terminal':
      return <TerminalIcon />;
    case 'thread':
      return <MessageSquareIcon />;
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
