// The workspace shell the templates are seen in: the real tab bar, sidebar,
// Project panel and tab panel around whatever main area a story passes, laid
// out by `WorkspaceLayout` as the workspace view lays them out. It renders
// inside a `LayoutHost`, whose fake host answers the panel's region items and
// the elements other bundles draw.

import { SidebarInset, SidebarProvider } from 'desktop/ui/sidebar';
import { Tabs } from 'desktop/ui/tabs';
import {
  type CSSProperties,
  createElement,
  type ReactNode,
  useState,
} from 'react';

import { ElementHost } from '../../src/client/components/molecules/element-host.js';
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
import { INSET_CARD } from '../../src/client/components/templates/inset-card.js';
import { WorkspaceLayout } from '../../src/client/components/templates/workspace-layout.js';
import { useRegionItems } from '../../src/client/hooks/use-region-items.js';
import { useWorkspaceTabs } from '../../src/client/hooks/use-workspace-tabs.js';
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

/** `<files-toggle placement>` props; made through `ui/v1` (`ElementHost`). */
const headerToggle = { placement: 'header' } as const;
const panelToggle = { placement: 'panel' } as const;

/** The bar under the conversation: the `layout.footer` region. */
export function ContentFooter() {
  return (
    <footer
      data-slot="workspace-footer"
      className="flex h-7 shrink-0 items-center justify-end gap-1 pl-2 text-[11px] font-normal"
    >
      {region('layout.footer')}
    </footer>
  );
}

export function WorkspaceShell({
  children,
  panel = true,
  panelOpen = true,
  owner = planThread.id,
  path = threadRoute(planThread),
  model = sidebarModelOf(),
}: {
  /** What the main panel shows, inside the sidebar inset. */
  readonly children: ReactNode;
  /** Whether the Project panel exists at all. */
  readonly panel?: boolean;
  readonly panelOpen?: boolean;
  /** The owner of the tabs drawn beside the conversation. */
  readonly owner?: string;
  /** The window path the Project tabs show. */
  readonly path?: string;
  readonly model?: SidebarModel;
}) {
  const [open, setOpen] = useState(panelOpen);
  const [active, setActive] = useState('files');
  const items = useRegionItems('layout.panel');
  const tabs = useWorkspaceTabs(owner);
  const viewer = tabs.items.length > 0;
  const filesShown = panel && open;
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
              actions={
                <>
                  {region('layout.header')}
                  {!filesShown && (
                    <>
                      <ElementHost tag="files-toggle" props={headerToggle} />
                      <AccountStatus onOpenSettings={openSettings} />
                    </>
                  )}
                </>
              }
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
                onActiveChange={(id) => {
                  setActive(id);
                  setOpen(true);
                }}
                items={items}
              />
              <div className="ml-auto flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
                <ElementHost tag="files-toggle" props={panelToggle} />
                <AccountStatus onOpenSettings={openSettings} />
              </div>
            </>
          }
          filesFooter={
            <div className="flex h-7 min-w-0 flex-1 items-center gap-1">
              {region('layout.panel.footer')}
            </div>
          }
          filesOpen={filesShown}
          fileViewer={viewer ? <WorkspaceTabs state={tabs} /> : undefined}
          onFilesOpenChange={setOpen}
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
          <SidebarInset className={INSET_CARD}>
            {children}
            <ContentFooter />
          </SidebarInset>
        </WorkspaceLayout>
      </Tabs>
    </SidebarProvider>
  );
}
