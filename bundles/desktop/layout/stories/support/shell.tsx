// The workspace shell the templates are seen in: the real tab bar, sidebar,
// Project panel and tab panel around whatever main area a story passes, laid
// out by `WorkspaceLayout` as the workspace view lays them out. It renders
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

import { AccountStatus } from '../../src/client/components/organisms/account-status.js';
import {
  ProjectPanel,
  ProjectPanelTabs,
} from '../../src/client/components/organisms/project-panel.js';
import type { SidebarModel } from '../../src/client/components/organisms/project-sidebar.js';
import { ProjectSidebar } from '../../src/client/components/organisms/project-sidebar.js';
import { ProjectTabBar } from '../../src/client/components/organisms/project-tabs.js';
import { SidebarHeader } from '../../src/client/components/organisms/sidebar-header.js';
import {
  WorkspaceTabBar,
  WorkspaceTabs,
} from '../../src/client/components/organisms/workspace-tabs.js';
import { ConversationFrame } from '../../src/client/components/templates/conversation-frame.js';
import { INSET_CARD } from '../../src/client/components/templates/inset-card.js';
import { WorkspaceLayout } from '../../src/client/components/templates/workspace-layout.js';
import { isThreadPanelTab } from '../../src/client/domain/workspace-tabs.js';
import { useWorkspaceTabs } from '../../src/client/hooks/use-workspace-tabs.js';
import { layoutServices } from '../../src/client/services/layout-services.js';
import { workspaceTabsStore } from '../../src/client/stores/workspace-tabs.js';
import { billing, checkout, docs, planThread, threadRoute } from './data.js';
import {
  projectTabsOf,
  sidebarActions,
  sidebarModelOf,
  workspaceActions,
} from './workspace.js';

const panelWidth = { '--sidebar-width': '100%' } as CSSProperties;

const region = (name: string) => createElement('core-region', { name });

/**
 * The conversation frame with the `layout.footer` region floating over its
 * bottom, as the workspace view draws it inside the split's top panel.
 */
export function ContentFrame({ children }: { readonly children: ReactNode }) {
  return (
    <ConversationFrame footer={region('layout.footer')}>
      {children}
    </ConversationFrame>
  );
}

export function WorkspaceShell({
  children,
  panel = true,
  owner = planThread.id,
  path = threadRoute(planThread),
  model = sidebarModelOf(),
}: {
  /** What the main panel shows, inside the sidebar inset. */
  readonly children: ReactNode;
  /** Whether the Project panel exists at all. */
  readonly panel?: boolean;
  /** The owner of the tabs drawn beside the conversation. */
  readonly owner?: string;
  /** The window path the Project tabs show. */
  readonly path?: string;
  readonly model?: SidebarModel;
}) {
  const [active, setActive] = useState('files');
  const items = useRegionItems(layoutServices().use(RegionsV1), 'layout.panel');
  const tabs = useWorkspaceTabs(owner);
  const viewer = tabs.items.length > 0;
  const openSettings = () => console.info('Story open settings');

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
          header={
            <ProjectTabBar
              actions={region('layout.header')}
              state={projectTabsOf([checkout, docs, billing])}
              path={path}
              projects={[checkout, docs, billing]}
              navigate={(path) => console.info('Story navigate', path)}
              close={(id) => console.info('Story close tab', id)}
              closeMany={(ids) => console.info('Story close tabs', ids)}
              move={(from, to) => console.info('Story move tab', from, to)}
              onNewProject={workspaceActions.beginProject}
              onNewThread={(project) =>
                workspaceActions.beginThread(project.id)
              }
              setColor={workspaceActions.setProjectColor}
              rename={(project, name) =>
                workspaceActions.rename(
                  { kind: 'project', value: project },
                  name,
                )
              }
            />
          }
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
                <AccountStatus onOpenSettings={openSettings} />
              </div>
            </>
          }
          filesFooter={
            <div className="flex h-7 min-w-0 flex-1 items-center gap-1">
              {region('layout.panel.footer')}
            </div>
          }
          fileViewer={viewer ? <WorkspaceTabs state={tabs} /> : undefined}
          viewerOpenBottom={tabs.items.some(
            (tab) => tab.id === tabs.selected && isThreadPanelTab(tab),
          )}
          sidebar={
            <ProjectSidebar
              header={
                <SidebarHeader
                  onDashboard={() =>
                    console.info('Story navigate', '/projects')
                  }
                />
              }
              actions={sidebarActions}
              model={model}
            />
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
