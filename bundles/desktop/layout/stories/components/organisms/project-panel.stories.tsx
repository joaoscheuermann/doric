import { SidebarScope } from 'desktop/ui/sidebar';
import { ActivityIcon } from 'lucide-react';
import { type CSSProperties, useState } from 'react';

import {
  type PanelBuiltIn,
  ProjectPanel,
  ProjectPanelTabs,
} from '../../../src/client/components/organisms/project-panel.js';
import { useRegionItems } from '../../../src/client/hooks/use-region-items.js';
import { LayoutHost } from '../../support/layout-host.js';

const fill = { '--sidebar-width': '100%' } as CSSProperties;

const activity: PanelBuiltIn = {
  id: 'activity',
  label: 'Activity',
  icon: <ActivityIcon />,
};

/** The panel as the workspace draws it: its tabs in the bar above it. */
function Panel({
  builtIns,
  initial = 'files',
  regions = true,
}: {
  readonly builtIns?: readonly PanelBuiltIn[];
  readonly initial?: string;
  readonly regions?: boolean;
}) {
  const [active, setActive] = useState(initial);
  const registered = useRegionItems('layout.panel');
  const items = regions ? registered : [];
  return (
    <SidebarScope>
      <div className="flex h-[600px] w-80 flex-col border" style={fill}>
        <div className="flex h-10 shrink-0 items-center justify-end border-b bg-[var(--paper-panel)] px-2">
          <ProjectPanelTabs
            active={active}
            onActiveChange={setActive}
            builtIns={builtIns}
            items={items}
          />
        </div>
        <div className="min-h-0 flex-1">
          <ProjectPanel
            active={active}
            builtIns={builtIns}
            builtInContent={
              <p className="p-3 text-xs text-muted-foreground">
                Sandbox activity for Checkout redesign: 3 commands ran in the
                last hour.
              </p>
            }
            items={items}
          />
        </div>
      </div>
    </SidebarScope>
  );
}

export default {
  title: 'Layout/Organisms/Project panel',
  component: ProjectPanel,
};

/** The Files view, as the panel opens. */
export const Files = {
  render: () => (
    <LayoutHost>
      <Panel />
    </LayoutHost>
  ),
};

/** The Changes view, whose tab carries the git bundle's badge. */
export const Changes = {
  render: () => (
    <LayoutHost>
      <Panel initial="changes" />
    </LayoutHost>
  ),
};

/** A view the layout draws itself beside the region's views. */
export const BuiltInView = {
  render: () => (
    <LayoutHost>
      <Panel builtIns={[activity]} initial="activity" />
    </LayoutHost>
  ),
};

/** No bundle added a view: the tab bar and the panel are empty. */
export const NoViews = {
  render: () => (
    <LayoutHost>
      <Panel regions={false} />
    </LayoutHost>
  ),
};
