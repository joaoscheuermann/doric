// `<layout-workspace>` (stage 9 §5.4; bundle isolation 4(a) change 7): the
// window's frame, in one of two forms (section 5, D5). The page form, while
// `shell.page` holds an item, draws the sidebar column (`shell.sidebar`, the
// quarantine notice, `shell.sidebar.footer`) beside the title bar
// (`shell.titlebar.tabs`) over `shell.page`. The conversation form draws the
// sidebar column with the stack panes, the title bar, the conversation (the
// child route in `<core-outlet>`, the `shell.conversation.footer` region floating over its
// bottom, the `layout.overlay` layer over it) and the side panel, whose
// header ends with `shell.window.actions`. The navigation fills the slots
// with elements of its own (`elements/navigation-elements.tsx`).

import { QueryClientProvider } from '@tanstack/react-query';
import { RegionsV1 } from 'bundle/contracts';
import { useRegionItems } from 'desktop/ui/element-host';
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarScope,
} from 'desktop/ui/sidebar';
import { Toaster } from 'desktop/ui/sonner';
import { Tabs } from 'desktop/ui/tabs';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { cn } from 'desktop/ui/utils';
import {
  type CSSProperties,
  createElement,
  StrictMode,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';

import {
  SHELL_CONVERSATION_FOOTER,
  SHELL_PAGE,
  SHELL_SIDEBAR,
  SHELL_SIDEBAR_FOOTER,
  SHELL_TITLEBAR_TABS,
  SHELL_WINDOW_ACTIONS,
} from '../../contracts/index.js';
import { BundleHealthNotice } from '../components/molecules/bundle-health-notice.js';
import {
  ProjectPanel,
  ProjectPanelTabs,
} from '../components/organisms/project-panel.js';
import { ProjectSidebarColumn } from '../components/organisms/project-sidebar.js';
import {
  WorkspaceTabBar,
  WorkspaceTabs,
} from '../components/organisms/workspace-tabs.js';
import { ConversationFrame } from '../components/templates/conversation-frame.js';
import { ConversationTerminals } from '../components/templates/conversation-terminals.js';
import { INSET_CARD } from '../components/templates/inset-card.js';
import { ThreadPane } from '../components/templates/thread-pane.js';
import { WorkspaceLayout } from '../components/templates/workspace-layout.js';
import { useWorkspaceTabs } from '../hooks/use-workspace-tabs.js';
import { layoutQueryClient } from '../queries/client.js';
import { layoutServices } from '../services/layout-services.js';
import { bottomStore } from '../stores/bottom.js';
import { panelStore } from '../stores/panel.js';
import { workspaceTabsStore } from '../stores/workspace-tabs.js';

/** The panel owns the sidebar width, so the sidebar fills whatever it drags to. */
const panelWidth = {
  '--sidebar-width': '100%',
} as CSSProperties;

/** A `<core-region name>`: `display: contents`, no role of its own. */
const Region = ({ name }: { readonly name: string }) =>
  createElement('core-region', { name });

/**
 * Draws `region`, a `<core-region>` the frame keeps across its forms, in
 * place: each form hosts the same element, moved within one commit, so the
 * region keeps its items' elements when the form changes (the core's region
 * and the elements it creates outlive a move in the same task).
 */
const KeptRegion = ({ region }: { readonly region: HTMLElement }) => (
  <div
    className="contents"
    ref={(host) => {
      if (host !== null && region.parentNode !== host) host.append(region);
    }}
  />
);

function Workspace() {
  const regions = layoutServices().use(RegionsV1);
  // `shell.sidebar` holds `layout-sidebar`, which runs the navigation's
  // once-per-window effects: both forms draw this one region element.
  const sidebarRegion = useMemo(() => {
    const element = document.createElement('core-region');
    element.setAttribute('name', SHELL_SIDEBAR);
    return element;
  }, []);
  const pageForm = useRegionItems(regions, SHELL_PAGE).length > 0;
  const footerItems = useRegionItems(regions, SHELL_SIDEBAR_FOOTER);
  const footer =
    footerItems.length > 0 ? <Region name={SHELL_SIDEBAR_FOOTER} /> : null;
  // The owner the layout's watcher names in the tabs store (bundle isolation
  // 4a, O9): `layout.tabs/v2` `setOwner` switches what the frame shows.
  const tabOwner = useSyncExternalStore(
    workspaceTabsStore.subscribe,
    () => workspaceTabsStore.getState().owner,
  );
  const tabs = useWorkspaceTabs(tabOwner);
  const panelView = useSyncExternalStore(
    panelStore.subscribe,
    () => panelStore.getState().active,
  );
  const panel = panelStore.getState();
  const panelItems = useRegionItems(regions, 'layout.panel');
  const bottomVisible = useSyncExternalStore(
    bottomStore.subscribe,
    () => bottomStore.getState().visible.size > 0,
  );
  if (pageForm) {
    // The page form (section 5, D5): the sidebar column, then the title bar
    // over the page. The sidebar comes first, so the tab bar keeps no macOS
    // inset (`85:7726`, UR1).
    return (
      <div className="flex h-svh min-h-0 flex-col bg-background text-foreground">
        <div className="flex min-h-0 flex-1 bg-sidebar">
          <aside className="flex shrink-0" aria-label="Dashboard navigation">
            <SidebarScope>
              <Sidebar
                collapsible="none"
                className="h-full w-[280px] shrink-0 font-normal"
              >
                <KeptRegion region={sidebarRegion} />
                <BundleHealthNotice className="mx-2 shrink-0" />
                {footer}
              </Sidebar>
            </SidebarScope>
          </aside>
          <div
            data-slot="dashboard-content"
            className="flex min-w-0 flex-1 flex-col bg-sidebar"
          >
            <Region name={SHELL_TITLEBAR_TABS} />
            <Region name={SHELL_PAGE} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-svh min-h-0 flex-col bg-sidebar text-foreground">
      <SidebarProvider
        style={panelWidth}
        className="min-h-0 flex-1 flex-col overflow-hidden"
      >
        <Tabs
          value={tabs.selected ?? ''}
          onValueChange={(id) => {
            if (tabOwner) workspaceTabsStore.getState().select(tabOwner, id);
          }}
          className="min-h-0 flex-1 gap-0"
        >
          <WorkspaceLayout
            header={<Region name={SHELL_TITLEBAR_TABS} />}
            viewerTabs={
              tabs.items.length > 0 && tabOwner ? (
                <WorkspaceTabBar state={tabs} threadId={tabOwner} />
              ) : undefined
            }
            files={<ProjectPanel active={panelView} items={panelItems} />}
            filesHeader={
              <>
                <ProjectPanelTabs
                  active={panelView}
                  onActiveChange={panel.select}
                  items={panelItems}
                />
                <div className="ml-auto flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
                  <Region name={SHELL_WINDOW_ACTIONS} />
                </div>
              </>
            }
            filesFooter={
              <div className="flex h-7 min-w-0 flex-1 items-center gap-1">
                <Region name="layout.panel.footer" />
              </div>
            }
            fileViewer={
              tabs.items.length === 0 || !tabOwner ? undefined : (
                <WorkspaceTabs state={tabs} />
              )
            }
            viewerOpenBottom={tabs.items.some(
              (tab) =>
                tab.id === tabs.selected &&
                tab.kind === 'element' &&
                tab.openBottom === true,
            )}
            sidebar={
              <ProjectSidebarColumn footer={footer}>
                <KeptRegion region={sidebarRegion} />
              </ProjectSidebarColumn>
            }
          >
            <SidebarInset className={cn(INSET_CARD, 'pb-0')}>
              <ConversationTerminals
                bottom={bottomVisible && <Region name="layout.main.bottom" />}
              >
                <ConversationFrame
                  footer={<Region name={SHELL_CONVERSATION_FOOTER} />}
                >
                  <ThreadPane>{createElement('core-outlet')}</ThreadPane>
                </ConversationFrame>
              </ConversationTerminals>
              {/*
                The floating layer over the conversation area: `layout.overlay`
                items place themselves, and the layer itself never intercepts
                a pointer.
              */}
              <div
                data-slot="workspace-overlay"
                className="pointer-events-none absolute inset-0 z-20"
              >
                <Region name="layout.overlay" />
              </div>
            </SidebarInset>
          </WorkspaceLayout>
        </Tabs>
      </SidebarProvider>
    </div>
  );
}

/** The workspace window's frame, with the window's only toaster. */
export function WorkspaceView() {
  useEffect(() => {
    document.title = 'Doric';
  }, []);
  return (
    <StrictMode>
      <QueryClientProvider client={layoutQueryClient()}>
        <TooltipProvider>
          <Workspace />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
