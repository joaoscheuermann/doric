// The tab panel beside the conversation: every tab is another bundle's
// element (`layout.tabs/v1`) since WP-10N moved the file, diff and terminal
// tabs to the files, git and terminal bundles.

import { TabStrip } from 'desktop/ui/panels';
import { TabsContent } from 'desktop/ui/tabs';
import { FileDiffIcon, FileIcon, TerminalIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { LayoutTabsV1 } from '../../../contracts/index.js';
import { type ThreadKind, threadKind } from '../../domain/thread-kind.js';
import type {
  WorkspaceTabs as TabsState,
  WorkspaceTab,
} from '../../domain/workspace-tabs.js';
import { layoutServices } from '../../services/layout-services.js';
import { workspaceStore } from '../../stores/workspace.js';
import { workspaceTabsStore } from '../../stores/workspace-tabs.js';
import { ThreadKindIcon } from '../molecules/thread-mark.js';

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
                icon: tabIcon(tab),
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
                  keepMounted
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

/**
 * The trigger icon of an element tab. A conversation tab wears the mark of the
 * Thread it shows — the bubble, the bubble with a plus or the bot, sized with
 * the label — read from the tree the window already holds, so the strip says
 * which Threads are agent Threads.
 */
function tabIcon(tab: Extract<WorkspaceTab, { readonly kind: 'element' }>) {
  switch (tab.icon) {
    case 'file':
      return <FileIcon />;
    case 'file-diff':
      return <FileDiffIcon />;
    case 'terminal':
      return <TerminalIcon />;
    case 'thread': {
      const thread = threadOfTab(tab);
      const kind: ThreadKind = thread === undefined ? 'main' : threadKind(thread);
      return <ThreadKindIcon kind={kind} />;
    }
    default:
      return null;
  }
}

/** The Thread a conversation tab names, when the window's tree holds it. */
const threadOfTab = (
  tab: Extract<WorkspaceTab, { readonly kind: 'element' }>,
) => {
  const projectId = tab.props?.projectId;
  const threadId = tab.props?.threadId;
  if (typeof projectId !== 'string' || typeof threadId !== 'string')
    return undefined;
  return workspaceStore
    .getState()
    .tree.threadsByProject[projectId]?.find((thread) => thread.id === threadId);
};

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
