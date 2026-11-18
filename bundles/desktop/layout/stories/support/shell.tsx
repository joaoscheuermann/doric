// The workspace shell the templates are seen in: the Project panel and tab
// panel around whatever main area a story passes, laid out by
// `WorkspaceLayout` as the workspace view lays them out. The tab bar and the
// sidebar's content are the `workspace` bundle's since bundle isolation 4(c)
// and show here as the stand-ins of their slots. It renders
// inside a `LayoutHost`, whose fake host answers the panel's region items and
// the elements other bundles draw.

import { RegionsV1 } from 'bundle/contracts';
import { useRegionItems } from 'desktop/ui/element-host';
import { SidebarInset, SidebarProvider } from 'desktop/ui/sidebar';
import { Tabs } from 'desktop/ui/tabs';
import { cn } from 'desktop/ui/utils';
import {
  type CSSProperties,
  createElement,
  type ReactNode,
  useState,
} from 'react';

import {
  ProjectPanel,
  ProjectPanelTabs,
} from '../../src/client/components/organisms/project-panel.js';
import { ProjectSidebarColumn } from '../../src/client/components/organisms/project-sidebar.js';
import {
  WorkspaceTabBar,
  WorkspaceTabs,
} from '../../src/client/components/organisms/workspace-tabs.js';
import { ConversationFrame } from '../../src/client/components/templates/conversation-frame.js';
import { INSET_CARD } from '../../src/client/components/templates/inset-card.js';
import { WorkspaceLayout } from '../../src/client/components/templates/workspace-layout.js';
import { useWorkspaceTabs } from '../../src/client/hooks/use-workspace-tabs.js';
import { layoutServices } from '../../src/client/services/layout-services.js';
import { workspaceTabsStore } from '../../src/client/stores/workspace-tabs.js';
import { Placeholder } from './placeholder.js';
import { owner as storyOwner } from './tabs.js';

const panelWidth = { '--sidebar-width': '100%' } as CSSProperties;

const region = (name: string) => createElement('core-region', { name });

/**
 * The conversation frame with the `shell.conversation.footer` region floating over its
 * bottom, as the workspace view draws it inside the split's top panel.
 */
export function ContentFrame({ children }: { readonly children: ReactNode }) {
  return (
    <ConversationFrame footer={region('shell.conversation.footer')}>
      {children}
    </ConversationFrame>
  );
}

export function WorkspaceShell({
  children,
  panel = true,
  owner = storyOwner,
}: {
  /** What the main panel shows, inside the sidebar inset. */
  readonly children: ReactNode;
  /** Whether the Project panel exists at all. */
  readonly panel?: boolean;
  /** The owner of the tabs drawn beside the conversation. */
  readonly owner?: string;
}) {
  const [active, setActive] = useState('files');
  const items = useRegionItems(layoutServices().use(RegionsV1), 'shell.panel');
  const tabs = useWorkspaceTabs(owner);
  const viewer = tabs.items.length > 0;

  return (
    <SidebarProvider
      style={panelWidth}
      className="min-h-0 flex-1 flex-col overflow-hidden"
    >
      <Tabs
        value={tabs.selected ?? ''}
        onValueChange={(id) => workspaceTabsStore.getState().select(owner, id)}
        className="min-h-0 flex-1 gap-0"
      >
        <WorkspaceLayout
          header={<Placeholder tag="workspace-project-tabs" />}
          viewerTabs={
            viewer ? (
              <WorkspaceTabBar state={tabs} threadId={owner} />
            ) : undefined
          }
          files={
            panel ? <ProjectPanel active={active} items={items} /> : undefined
          }
          filesHeader={
            <>
              <ProjectPanelTabs
                active={active}
                onActiveChange={setActive}
                items={items}
              />
              <div className="ml-auto flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
                <Placeholder tag="account-status" />
              </div>
            </>
          }
          filesFooter={
            <div className="flex h-7 min-w-0 flex-1 items-center gap-1">
              {region('shell.panel.footer')}
            </div>
          }
          fileViewer={viewer ? <WorkspaceTabs state={tabs} /> : undefined}
          viewerOpenBottom={tabs.items.some(
            (tab) =>
              tab.id === tabs.selected &&
              tab.kind === 'element' &&
              tab.openBottom === true,
          )}
          sidebar={
            // As the conversation form draws its column: the frame's panes
            // and notice under the sidebar's own content.
            <ProjectSidebarColumn>
              <Placeholder tag="workspace-sidebar" />
            </ProjectSidebarColumn>
          }
        >
          {/* No bottom padding, as the app's conversation card (D14): the
          stories put `ContentFrame`, whose band stands on the card's edge,
          in this card. */}
          <SidebarInset className={cn(INSET_CARD, 'pb-0')}>
            {children}
          </SidebarInset>
        </WorkspaceLayout>
      </Tabs>
    </SidebarProvider>
  );
}
